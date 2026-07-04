#!/usr/bin/env node
const fs = require('fs');
const env = require('../config/env');
const navigator = require('../lib/navigatorClient');
const sanitizer = require('../services/sanitizer');
const chromaClient = require('../services/chromaClient');

const MAX_CHUNK_CHARS = 800;
const OVERLAP_CHARS = 120; // ~15% overlap so a fact split across a chunk boundary isn't lost

const PUBLIC_KEYWORDS = [
    'hours', 'hour', 'pricing', 'price', 'cost', 'rate', 'location', 'general information',
    'how to play', 'equipment list', 'offerings', 'about us', 'faq', 'rules for guests',
    'visitor information', 'directions',
];

function isHeadingLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (/^#{1,6}\s+\S/.test(trimmed)) {
        return trimmed.replace(/^#{1,6}\s+/, '').trim();
    }
    if (/^[A-Z0-9][A-Z0-9\s&/,'-]{2,78}$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
        return trimmed;
    }
    // Deliberately NOT treating numbered lines ("1. Do the thing") as headings — real
    // manuals routinely have numbered steps *inside* a procedure, and a heuristic that
    // can't tell "1. Introduction" from "1. Post your shift for trade" will fragment a
    // single staff-only procedure into several chunks, some of which can be misclassified
    // by the access-level keyword heuristic below. Verified this fragmentation actually
    // happened during testing against a real manual — a numbered step mid-procedure was
    // split off and auto-tagged "public". ALL-CAPS and markdown headings don't have this
    // failure mode, so they're the only supported conventions.
    return null;
}

function parseAccessMarker(line) {
    const match = line.trim().match(/^\[(PUBLIC|STAFF)\]$/i);
    return match ? match[1].toLowerCase() : null;
}

function parseSections(text) {
    const lines = text.split(/\r?\n/);
    const sections = [];
    let current = { title: 'General', bodyLines: [], accessOverride: null };

    for (const line of lines) {
        const heading = isHeadingLine(line);
        if (heading) {
            if (current.bodyLines.some((l) => l.trim())) {
                sections.push(current);
            }
            current = { title: heading, bodyLines: [], accessOverride: null };
            continue;
        }
        if (!current.accessOverride) {
            const marker = parseAccessMarker(line);
            if (marker) {
                current.accessOverride = marker;
                continue;
            }
        }
        current.bodyLines.push(line);
    }
    if (current.bodyLines.some((l) => l.trim())) {
        sections.push(current);
    }
    return sections;
}

function detectAccessLevel(section) {
    if (section.accessOverride) return section.accessOverride;
    const haystack = (section.title + ' ' + section.bodyLines.slice(0, 3).join(' ')).toLowerCase();
    const isPublic = PUBLIC_KEYWORDS.some((kw) => haystack.includes(kw));
    return isPublic ? 'public' : 'staff'; // default: restricted unless clearly general info
}

function splitIntoParagraphs(bodyLines) {
    const text = bodyLines.join('\n');
    return text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}

function chunkParagraphs(paragraphs, maxLen = MAX_CHUNK_CHARS) {
    const chunks = [];
    let current = '';

    const pushCurrent = () => {
        if (current.trim()) chunks.push(current.trim());
        current = '';
    };

    for (const paragraph of paragraphs) {
        if (paragraph.length > maxLen) {
            pushCurrent();
            const sentences = paragraph.split(/(?<=[.!?])\s+/);
            let piece = '';
            for (const sentence of sentences) {
                const candidate = piece ? `${piece} ${sentence}` : sentence;
                if (candidate.length > maxLen && piece) {
                    chunks.push(piece.trim());
                    piece = sentence;
                } else {
                    piece = candidate;
                }
            }
            if (piece.trim()) chunks.push(piece.trim());
        } else if (current && (current.length + paragraph.length + 2) > maxLen) {
            pushCurrent();
            current = paragraph;
        } else {
            current = current ? `${current}\n\n${paragraph}` : paragraph;
        }
    }
    pushCurrent();
    return chunks;
}

// Adds a short overlap: each chunk after the first is prefixed with the tail of the previous
// one (snapped to a word boundary). A fact that lands right on a chunk boundary — a price and
// the condition attached to it, say — then appears whole in at least one chunk instead of being
// split and lost to retrieval. Applied AFTER chunkParagraphs so that function keeps its clean
// "every base chunk is within maxLen" contract; overlap is a deliberate, separate transform.
// Overlap stays within a single section's chunks, so it never bleeds across an access boundary.
function addOverlap(chunks, overlapChars = OVERLAP_CHARS) {
    if (overlapChars <= 0 || chunks.length < 2) return chunks.slice();
    return chunks.map((chunk, i) => {
        if (i === 0) return chunk;
        const prev = chunks[i - 1];
        let tail = prev.slice(Math.max(0, prev.length - overlapChars));
        const spaceIdx = tail.indexOf(' ');
        if (spaceIdx > 0) tail = tail.slice(spaceIdx + 1); // start at a word boundary
        tail = tail.trim();
        return tail ? `${tail} ${chunk}` : chunk;
    });
}

function slugify(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'section';
}

async function main() {
    if (!env.hasApiKey()) {
        console.error('NAVIGATOR_API_KEY is not set — cannot generate embeddings. Aborting.');
        process.exit(1);
    }
    if (!env.hasManual()) {
        console.error(`No manual found at ${env.MANUAL_PATH}. Add the file and re-run.`);
        process.exit(1);
    }

    const rawText = fs.readFileSync(env.MANUAL_PATH, 'utf8');
    const { text: sanitizedText, redactionCount } = sanitizer.sanitize(rawText);
    console.log(`Sanitized manual: redacted ${redactionCount} credential/PII match(es).`);

    const sections = parseSections(sanitizedText);
    console.log(`Parsed ${sections.length} section(s).`);

    const records = [];
    for (const section of sections) {
        const accessLevel = detectAccessLevel(section);
        const paragraphs = splitIntoParagraphs(section.bodyLines);
        const chunks = addOverlap(chunkParagraphs(paragraphs));
        const slug = slugify(section.title);
        chunks.forEach((chunkText, i) => {
            records.push({
                id: `${slug}-${i}`,
                section: section.title,
                accessLevel,
                text: chunkText,
            });
        });
    }

    if (records.length === 0) {
        console.error('No content chunks were produced from the manual. Nothing to ingest.');
        process.exit(1);
    }

    console.log(`Built ${records.length} chunk(s). Embedding via Navigator (${env.EMBED_MODEL})...`);

    const embeddings = [];
    for (let i = 0; i < records.length; i++) {
        const embedding = await navigator.embed(records[i].text);
        embeddings.push(embedding);
        if ((i + 1) % 10 === 0 || i === records.length - 1) {
            console.log(`  embedded ${i + 1}/${records.length}`);
        }
    }

    console.log('Rebuilding Chroma collection (clean slate)...');
    const collection = await chromaClient.resetCollection();

    const BATCH_SIZE = 100;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const batchEmbeddings = embeddings.slice(i, i + BATCH_SIZE);
        await collection.add({
            ids: batch.map((r) => r.id),
            embeddings: batchEmbeddings,
            documents: batch.map((r) => r.text),
            metadatas: batch.map((r) => ({ section: r.section, access_level: r.accessLevel })),
        });
    }

    const publicCount = records.filter((r) => r.accessLevel === 'public').length;
    const staffCount = records.length - publicCount;
    console.log(`Done. Ingested ${records.length} chunk(s) into "${env.CHROMA_COLLECTION}" (${publicCount} public, ${staffCount} staff-only).`);
    console.log('Tip: tag a section explicitly by putting a line containing only [PUBLIC] or [STAFF] right after its heading.');
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Ingestion failed:', error.message);
        process.exit(1);
    });
}

module.exports = {
    isHeadingLine,
    parseAccessMarker,
    parseSections,
    detectAccessLevel,
    splitIntoParagraphs,
    chunkParagraphs,
    addOverlap,
    slugify,
};
