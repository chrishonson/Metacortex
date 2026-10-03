import { FieldValue, Timestamp } from "firebase-admin/firestore";

interface EncodedTimestamp {
  __fs: "timestamp";
  seconds: number;
  nanoseconds: number;
}

interface EncodedVector {
  __fs: "vector";
  values: number[];
}

interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis: () => number;
}

interface VectorLike {
  toArray: () => number[];
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

export function encodeValue(value: unknown): unknown {
  if (value === null || typeof value === "undefined") {
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

  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }

  if (typeof value === "object") {
    const encoded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      encoded[key] = encodeValue(nested);
    }
    return encoded;
  }

  return value;
}

export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value === "undefined") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.__fs === "timestamp") {
      return new Timestamp(Number(obj.seconds), Number(obj.nanoseconds));
    }
    if (obj.__fs === "vector") {
      return FieldValue.vector(obj.values as number[]);
    }
    const decoded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(obj)) {
      decoded[key] = decodeValue(nested);
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

export function decodeDocument(doc: Record<string, unknown>): {
  id: string;
  data: Record<string, unknown>;
} {
  const id = String(doc[DOCUMENT_ID_FIELD]);
  const fields = { ...doc };
  delete fields[DOCUMENT_ID_FIELD];
  return {
    id,
    data: decodeValue(fields) as Record<string, unknown>
  };
}
