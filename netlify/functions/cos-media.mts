import { createHash, createHmac } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const BUCKET = "maosery-1257301643";
const REGION = "ap-beijing";
const URL_EXPIRES_SECONDS = 60 * 60 * 12;

const directories = [
  { grade: "小班", time: "小班时光", prefix: "幼儿园时光/小班/" },
  { grade: "中班", time: "中班时光", prefix: "幼儿园时光/中班/" },
  { grade: "大班", time: "大班时光", prefix: "幼儿园时光/大班/" }
];

const photoExtensions = new Set([
  "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "webp"
]);
const videoExtensions = new Set([
  "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"
]);
const cosHost = `${BUCKET}.cos.${REGION}.myqcloud.com`;
const xmlParser = new XMLParser({
  ignoreDeclaration: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false
});

function safeEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function sortedKeys(record: Record<string, unknown>) {
  return Object.keys(record).sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase())
  );
}

function canonicalRecord(record: Record<string, unknown>, lowerCaseKeys = false) {
  return sortedKeys(record).map((originalKey) => {
    const key = lowerCaseKeys ? originalKey.toLowerCase() : originalKey;
    const value = record[originalKey] == null ? "" : String(record[originalKey]);
    return `${safeEncode(key)}=${safeEncode(value)}`;
  }).join("&");
}

function createAuthorization(options: {
  secretId: string;
  secretKey: string;
  pathname: string;
  query?: Record<string, unknown>;
  expires: number;
}) {
  const query = options.query || {};
  const headers = { host: cosHost };
  const now = Math.round(Date.now() / 1000) - 1;
  const keyTime = `${now};${now + options.expires}`;
  const headerList = sortedKeys(headers).map((key) => safeEncode(key).toLowerCase()).join(";");
  const urlParamList = sortedKeys(query).map((key) => safeEncode(key).toLowerCase()).join(";");
  const httpString = [
    "get",
    options.pathname,
    canonicalRecord(query, true),
    canonicalRecord(headers, true),
    ""
  ].join("\n");
  const signKey = createHmac("sha1", options.secretKey).update(keyTime).digest("hex");
  const stringToSign = [
    "sha1",
    keyTime,
    createHash("sha1").update(httpString, "utf8").digest("hex"),
    ""
  ].join("\n");
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");

  return [
    "q-sign-algorithm=sha1",
    `q-ak=${options.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${urlParamList}`,
    `q-signature=${signature}`
  ].join("&");
}

function signedObjectUrl(key: string, secretId: string, secretKey: string) {
  const authorization = createAuthorization({
    secretId,
    secretKey,
    pathname: `/${key}`,
    expires: URL_EXPIRES_SECONDS
  });
  const encodedKey = key.split("/").map(safeEncode).join("/");
  return `https://${cosHost}/${encodedKey}?${authorization}`;
}

async function getBucketPage(
  prefix: string,
  marker: string,
  secretId: string,
  secretKey: string
) {
  const query = {
    marker,
    "max-keys": 1000,
    prefix
  };
  const authorization = createAuthorization({
    secretId,
    secretKey,
    pathname: "/",
    query,
    expires: 600
  });
  const response = await fetch(`https://${cosHost}/?${canonicalRecord(query)}`, {
    headers: { Authorization: authorization }
  });

  if (!response.ok) {
    throw new Error(`COS list request failed with status ${response.status}`);
  }

  const parsed = xmlParser.parse(await response.text());
  return parsed.ListBucketResult || {};
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=60, stale-while-revalidate=300"
    }
  });
}

function titleFromKey(key: string) {
  const fileName = key.split("/").pop() || key;
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function kindFromKey(key: string) {
  const extension = key.split(".").pop()?.toLowerCase() || "";
  if (photoExtensions.has(extension)) return "photo";
  if (videoExtensions.has(extension)) return "video";
  return null;
}

export default async (request: Request) => {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const secretId = Netlify.env.get("TENCENT_COS_SECRET_ID");
  const secretKey = Netlify.env.get("TENCENT_COS_SECRET_KEY");

  if (!secretId || !secretKey) {
    return jsonResponse({
      error: "COS credentials are not configured",
      required: ["TENCENT_COS_SECRET_ID", "TENCENT_COS_SECRET_KEY"]
    }, 500);
  }

  try {
    const memories = [];

    for (const directory of directories) {
      let marker = "";
      let hasMore = true;

      while (hasMore) {
        const page = await getBucketPage(directory.prefix, marker, secretId, secretKey);
        const objects = !page.Contents
          ? []
          : Array.isArray(page.Contents) ? page.Contents : [page.Contents];

        for (const object of objects) {
          const key = object.Key;
          const kind = typeof key === "string" ? kindFromKey(key) : null;
          if (!key || key.endsWith("/") || !kind) continue;

          memories.push({
            id: key,
            kind,
            src: signedObjectUrl(key, secretId, secretKey),
            title: titleFromKey(key),
            grade: directory.grade,
            time: directory.time,
            frameAt: 2.5,
            lastModified: object.LastModified || ""
          });
        }

        hasMore = page.IsTruncated === true || page.IsTruncated === "true";
        marker = page.NextMarker || objects.at(-1)?.Key || "";
        if (hasMore && !marker) break;
      }
    }

    memories.sort((left, right) => left.id.localeCompare(right.id, "zh-CN"));

    return jsonResponse({
      bucket: BUCKET,
      region: REGION,
      count: memories.length,
      memories
    });
  } catch (error) {
    console.error("Unable to list COS media", error);
    return jsonResponse({ error: "Unable to read COS media" }, 502);
  }
};

export const config = {
  path: "/api/memories",
  method: ["GET"]
};
