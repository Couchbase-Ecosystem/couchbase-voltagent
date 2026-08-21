export class CouchbaseVectorAdapterConfigurationError extends Error {
  override readonly name = "CouchbaseVectorAdapterConfigurationError";
}

export class CouchbaseVectorValidationError extends Error {
  override readonly name = "CouchbaseVectorValidationError";
}

export class CouchbaseUnsupportedFilterError extends Error {
  override readonly name = "CouchbaseUnsupportedFilterError";
}

export class CouchbaseDocumentCollisionError extends Error {
  override readonly name = "CouchbaseDocumentCollisionError";
}
