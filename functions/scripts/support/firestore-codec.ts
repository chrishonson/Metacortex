import { FieldValue, GeoPoint, Timestamp } from "firebase-admin/firestore";

interface EncodedTimestamp {
  __fs: "timestamp";
  seconds: number;
  nanoseconds: number;
}

interface EncodedVector {
  __fs: "vector";
  values: number[];
}

interface EncodedGeoPoint {
  __fs: "geopoint";
  latitude: number;
  longitude: number;
}

interface EncodedBytes {
  __fs: "bytes";
  base64: string;
}

interface EncodedReference {
  __fs: "reference";
  path: string;
}

interface EncodedNumber {
  __fs: "number";
  value: "NaN" | "Infinity" | "-Infinity";
}

interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis: () => number;
}

interface VectorLike {
  toArray: () => number[];
}

export interface GeoPointLike {
  latitude: number;
  longitude: number;
}

export interface DocumentReferenceLike {
  path: string;
  firestore: object;
}

export const DOCUMENT_ID_FIELD = "_id";

export function isTimestamp(value: unknown): value is TimestampLike {
  return (
    value instanceof Timestamp ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as TimestampLike).toMillis === "function" &&
      typeof (value as TimestampLike).seconds === "number" &&
      (value.constructor?.name === "Timestamp" ||
        Object.prototype.hasOwnProperty.call(value, "nanoseconds")))
  );
}

export function isVectorValue(value: unknown): value is VectorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    value.constructor?.name === "VectorValue" &&
    typeof (value as VectorLike).toArray === "function"
  );
}

export function isGeoPoint(value: unknown): value is GeoPointLike {
  return (
    value instanceof GeoPoint ||
    (typeof value === "object" &&
      value !== null &&
      value.constructor?.name === "GeoPoint" &&
      typeof (value as GeoPointLike).latitude === "number" &&
      typeof (value as GeoPointLike).longitude === "number")
  );
}

export function isBytes(value: unknown): value is Buffer | Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

export function isDocumentReference(value: unknown): value is DocumentReferenceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DocumentReferenceLike).path === "string" &&
    typeof (value as DocumentReferenceLike).firestore === "object" &&
    value.constructor?.name === "DocumentReference"
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function encodeValue(value: unknown, currentPath = ""): unknown {
  if (value === null || typeof value === "undefined") {
    return value;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      const encoded: EncodedNumber = { __fs: "number", value: "NaN" };
      return encoded;
    }
    if (value === Infinity) {
      const encoded: EncodedNumber = { __fs: "number", value: "Infinity" };
      return encoded;
    }
    if (value === -Infinity) {
      const encoded: EncodedNumber = { __fs: "number", value: "-Infinity" };
      return encoded;
    }
    return value;
  }

  if (isTimestamp(value)) {
    const encoded: EncodedTimestamp = {
      __fs: "timestamp",
      seconds: value.seconds,
      nanoseconds: value.nanoseconds
    };
    return encoded;
  }

  if (value instanceof Date) {
    const millis = value.getTime();
    const encoded: EncodedTimestamp = {
      __fs: "timestamp",
      seconds: Math.floor(millis / 1000),
      nanoseconds: (millis % 1000) * 1e6
    };
    return encoded;
  }

  if (isVectorValue(value)) {
    const encoded: EncodedVector = {
      __fs: "vector",
      values: value.toArray()
    };
    return encoded;
  }

  if (isGeoPoint(value)) {
    const encoded: EncodedGeoPoint = {
      __fs: "geopoint",
      latitude: value.latitude,
      longitude: value.longitude
    };
    return encoded;
  }

  if (isBytes(value)) {
    const encoded: EncodedBytes = {
      __fs: "bytes",
      base64: Buffer.from(value).toString("base64")
    };
    return encoded;
  }

  if (isDocumentReference(value)) {
    const encoded: EncodedReference = {
      __fs: "reference",
      path: value.path
    };
    return encoded;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      encodeValue(item, currentPath ? `${currentPath}.${index}` : `${index}`)
    );
  }

  if (isPlainObject(value)) {
    if (Object.prototype.hasOwnProperty.call(value, "__fs")) {
      const fsPath = currentPath ? `${currentPath}.__fs` : "__fs";
      throw new Error(`reserved key "__fs" in field ${fsPath}`);
    }
    const encoded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      encoded[key] = encodeValue(nested, nextPath);
    }
    return encoded;
  }

  const typeName = (value as object).constructor?.name || typeof value;
  throw new Error(`cannot encode value of type ${typeName} at ${currentPath || "root"}`);
}

export function decodeValue(
  value: unknown,
  resolveReference?: (path: string) => unknown
): unknown {
  if (value === null || typeof value === "undefined") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => decodeValue(item, resolveReference));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.__fs === "string") {
      switch (obj.__fs) {
        case "timestamp": {
          if (
            typeof obj.seconds !== "number" ||
            typeof obj.nanoseconds !== "number" ||
            !Number.isFinite(obj.seconds) ||
            !Number.isFinite(obj.nanoseconds)
          ) {
            throw new Error("malformed timestamp tag");
          }
          return new Timestamp(obj.seconds, obj.nanoseconds);
        }
        case "vector": {
          if (
            !Array.isArray(obj.values) ||
            obj.values.some(v => typeof v !== "number" || !Number.isFinite(v))
          ) {
            throw new Error("malformed vector tag");
          }
          return FieldValue.vector(obj.values as number[]);
        }
        case "geopoint": {
          if (
            typeof obj.latitude !== "number" ||
            typeof obj.longitude !== "number" ||
            !Number.isFinite(obj.latitude) ||
            !Number.isFinite(obj.longitude)
          ) {
            throw new Error("malformed geopoint tag");
          }
          return new GeoPoint(obj.latitude, obj.longitude);
        }
        case "bytes": {
          if (typeof obj.base64 !== "string") {
            throw new Error("malformed bytes tag");
          }
          return Buffer.from(obj.base64, "base64");
        }
        case "reference": {
          if (typeof obj.path !== "string" || obj.path.trim().length === 0) {
            throw new Error("malformed reference tag");
          }
          if (!resolveReference) {
            throw new Error(
              `cannot decode reference without resolver for path ${obj.path}`
            );
          }
          return resolveReference(obj.path);
        }
        case "number": {
          if (obj.value === "NaN") {
            return Number.NaN;
          }
          if (obj.value === "Infinity") {
            return Number.POSITIVE_INFINITY;
          }
          if (obj.value === "-Infinity") {
            return Number.NEGATIVE_INFINITY;
          }
          throw new Error(`malformed number tag: ${String(obj.value)}`);
        }
        default:
          throw new Error(`unknown __fs tag: ${String(obj.__fs)}`);
      }
    }

    const decoded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(obj)) {
      decoded[key] = decodeValue(nested, resolveReference);
    }
    return decoded;
  }

  return value;
}

export function encodeDocument(
  id: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  return {
    [DOCUMENT_ID_FIELD]: id,
    ...(encodeValue(data) as Record<string, unknown>)
  };
}

export function decodeDocument(
  doc: Record<string, unknown>,
  resolveReference?: (path: string) => unknown
): {
  id: string;
  data: Record<string, unknown>;
} {
  const id = String(doc[DOCUMENT_ID_FIELD]);
  const fields = { ...doc };
  delete fields[DOCUMENT_ID_FIELD];
  return {
    id,
    data: decodeValue(fields, resolveReference) as Record<string, unknown>
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(item => (item === undefined ? "null" : stableStringify(item)));
    return `[${items.join(",")}]`;
  }

  const entries: string[] = [];
  const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const val = (value as Record<string, unknown>)[key];
    if (typeof val === "undefined") {
      continue;
    }
    entries.push(`${JSON.stringify(key)}:${stableStringify(val)}`);
  }
  return `{${entries.join(",")}}`;
}
