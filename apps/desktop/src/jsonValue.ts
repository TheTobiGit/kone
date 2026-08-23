// What `JSON.parse` can actually produce. Wire-narrowing helpers hand back
// JsonObject rather than Record<string, unknown>, so every field read yields
// a concrete JsonValue the consumer must still verify before trusting.

export type JsonObject = { [key: string]: JsonValue };

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
