## ADDED Requirements

### Requirement: Document Upload and Chunking

The KnowledgeBase SHALL accept document uploads in txt, md, and pdf formats, automatically split documents into chunks, and store them with configurable chunk sizes.

#### Scenario: Successful txt/md document upload
- **WHEN** `uploadDocument(file, ctx)` is called with a `.txt` or `.md` file
- **THEN** the system SHALL parse the file content, split it into chunks of `chunkSize` characters (with optional `chunkOverlap`), and persist the chunks to storage

#### Scenario: Successful pdf document upload
- **WHEN** `uploadDocument(file, ctx)` is called with a `.pdf` file
- **THEN** the system SHALL extract text from the PDF pages, split the text into chunks of configurable `chunkSize`, and persist the chunks

#### Scenario: Unsupported file format
- **WHEN** `uploadDocument(file, ctx)` is called with a file of an unsupported type (e.g., `.docx`)
- **THEN** the system SHALL return an `UnsupportedFileTypeError` and SHALL NOT store any data

#### Scenario: Configurable chunk size
- **WHEN** the `chunkSize` configuration is set to a specific value N
- **THEN** all chunks produced from uploaded documents SHALL have a character length not exceeding N

---

### Requirement: Document Embedding

The KnowledgeBase SHALL call the configured embedding API to convert each chunk into a vector and store the vectors in sqlite-vec.

#### Scenario: Embedding generated for each chunk
- **WHEN** a document is successfully split into M chunks
- **THEN** the system SHALL call the embedding API exactly M times and store each resulting vector alongside its chunk text in sqlite-vec

#### Scenario: Embedding API failure
- **WHEN** the embedding API returns an error for one or more chunks
- **THEN** the system SHALL retry up to 3 times with exponential backoff and, if still failing, mark the document upload as failed and return an `EmbeddingError`

---

### Requirement: Semantic Search

The KnowledgeBase SHALL provide a `search(query, topK, ctx)` method that returns the most semantically similar chunks to the query.

#### Scenario: Successful semantic search
- **WHEN** `search(query, topK, ctx)` is called with a non-empty query
- **THEN** the system SHALL embed the query, perform a cosine similarity search in sqlite-vec scoped to `ctx.tenantId`, and return the top K chunks ordered by descending similarity score

#### Scenario: Empty knowledge base
- **WHEN** `search(query, topK, ctx)` is called for a tenant with no uploaded documents
- **THEN** the method SHALL return an empty array without error

#### Scenario: topK exceeds available chunks
- **WHEN** `topK` is greater than the number of available chunks for the tenant
- **THEN** the method SHALL return all available chunks rather than an error

---

### Requirement: Document Deletion

The KnowledgeBase SHALL provide a `deleteDocument(docId, ctx)` method that removes all chunks and vectors associated with a document.

#### Scenario: Successful document deletion
- **WHEN** `deleteDocument(docId, ctx)` is called for an existing document within the tenant's scope
- **THEN** the system SHALL delete all chunk records and corresponding vectors from sqlite-vec for that `docId`

#### Scenario: Delete non-existent document
- **WHEN** `deleteDocument(docId, ctx)` is called with a `docId` that does not exist
- **THEN** the method SHALL return a `DocumentNotFoundError`

---

### Requirement: Tenant Isolation

The KnowledgeBase SHALL enforce tenant isolation so that documents and search results are scoped exclusively to `ctx.tenantId`.

#### Scenario: Search returns only tenant's documents
- **WHEN** tenant A and tenant B each upload documents and tenant A calls `search(query, topK, ctx)`
- **THEN** the results SHALL contain only chunks from tenant A's documents and SHALL NOT include any chunks from tenant B

#### Scenario: Cross-tenant deletion prevented
- **WHEN** `deleteDocument(docId, ctx)` is called where `docId` belongs to a different tenant
- **THEN** the method SHALL return a `DocumentNotFoundError` as if the document does not exist for the calling tenant
