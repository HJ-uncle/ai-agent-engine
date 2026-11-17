# Knowledge Base Specification

## Purpose

Describe current document extraction, tenant-scoped retrieval and session selection. Knowledge retrieval uses FTS5/LIKE rather than the memory graph's vector path. Source audit: 2026-11-17.

## Requirements

### Requirement: Persistent isolated document storage

Knowledge bases and extracted documents SHALL be tenant-scoped. Normal operation SHALL use a separate knowledge.db next to the main database; KNOWLEDGE_DATA_DIR can override the file. Tests/shared mode may explicitly use the main database.

#### Scenario: Selected resources

- **WHEN** a request supplies selected knowledge resource IDs
- **THEN** server metadata SHALL resolve and authorize those IDs
- **AND** selected scope SHALL intersect with allowed tenant resources
- **AND** resource IDs SHALL NOT be treated as arbitrary filesystem paths.

### Requirement: Supported extraction

The extractor SHALL handle supported text/code/HTML/SVG, Excel, Word, PDF and image inputs using available parsers/OCR.

#### Scenario: Scanned PDF

- **WHEN** PDF text extraction yields no usable text
- **THEN** OCR MAY process a bounded number of pages
- **AND** the default is 3 pages, clamped to 1–10, using eng+chi_sim unless configured otherwise.

Current upload limit is 2 MiB; direct text is limited to 1 MiB. Extraction success depends on file validity and deployed OCR/parser dependencies; uploading a file does not guarantee meaningful extraction.

### Requirement: Scoped search

Search SHALL use FTS5 with a LIKE fallback, constrained by tenant and selected knowledge bases. It SHALL NOT claim embedding/cosine ranking that is absent from the current repository implementation.

#### Scenario: Search limits

- **WHEN** a query is validated
- **THEN** scope IDs SHALL be bounded to 100, query text to 4000 characters and result limit to 1–100.
- **WHEN** no selected document matches
- **THEN** the result SHALL mean no matching retrieval evidence, not that the underlying library contains no documents.

The chat RAG default topK is 3. Retrieved RAG currently contributes to the constructed system prompt and is distinct from memory's dynamic tail.

### Requirement: Reading and management are separate

A Work request's explicit resource selection MAY grant trusted read tools without granting knowledge management mutations. Code SHALL NOT acquire the Work knowledge-management package.

#### Scenario: Selected read-only library

- **WHEN** a user attaches authorized knowledge resources
- **THEN** the engine SHALL permit only the corresponding selected reads
- **AND** SHALL NOT infer permission to create/delete libraries or rewrite documents.

## Source map

[Repository](../../../src/storage/knowledge/kb-repo.ts), [extractor](../../../src/storage/knowledge/content-extractor.ts), [types](../../../src/storage/knowledge/types.ts), [database](../../../src/storage/knowledge/db.ts), [registry](../../../src/tools/registry-factory.ts). Related tests are in [knowledge tests](../../../src/storage/knowledge/__tests__/). No OCR or external retrieval quality measurement was performed for this doc audit.
