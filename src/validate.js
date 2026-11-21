// Returns a list of human-readable problems; empty list means the request is valid.
// Kept synchronous and network-free so the ingestion endpoint stays instant.
export function validateDispatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Body must be a JSON object'];
  }

  const { destinationUrl, eventId, payload } = body;
  const errors = [];

  if (typeof destinationUrl !== 'string') {
    errors.push('destinationUrl must be a string');
  } else {
    try {
      const { protocol } = new URL(destinationUrl);
      if (protocol !== 'http:' && protocol !== 'https:') errors.push('destinationUrl must use http or https');
    } catch {
      errors.push('destinationUrl is not a valid URL');
    }
  }

  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 128) {
    errors.push('eventId must be a non-empty string (max 128 characters)');
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push('payload must be a JSON object');
  }

  return errors;
}
