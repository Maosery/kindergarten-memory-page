import { createHash, createHmac } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { Config, Context } from "@netlify/functions";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const BUCKET = "maosery-1257301643";
const REGION = "ap-beijing";

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

function publicObjectUrl(key: string) {
  const encodedKey = key.split("/").map(safeEncode).join("/");
  return `https://${cosHost}/${encodedKey}`;
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

export function metadataFromKey(key: string, stripExtension = true) {
  const fileName = key.split("/").pop() || key;
  const baseName = (stripExtension ? fileName.replace(/\.[^.]+$/, "") : fileName).trim();
  const fullDate = baseName.match(
    /^(\d{4})[-_.年](\d{1,2})[-_.月](\d{1,2})(?:日)?[-_\s]+(.+)$/
  );
  const compactDate = baseName.match(/^(\d{4})(\d{2})(\d{2})[-_\s]+(.+)$/);
  const monthDay = baseName.match(/^(\d{1,2})[-_.月](\d{1,2})(?:日)?[-_\s]+(.+)$/);
  const compactMonthDay = baseName.match(/^(\d{2})(\d{2})[-_\s]+(.+)$/);
  const match = fullDate || compactDate;

  if (match) {
    const [, year, month, day, rawTitle] = match;
    return {
      title: rawTitle.replace(/_/g, " ").trim(),
      date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
      dateLabel: `${Number(year)}年${Number(month)}月${Number(day)}日`
    };
  }

  const shortDate = monthDay || compactMonthDay;
  if (shortDate) {
    const [, month, day, rawTitle] = shortDate;
    return {
      title: rawTitle.replace(/_/g, " ").trim(),
      date: `${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
      dateLabel: `${Number(month)}月${Number(day)}日`
    };
  }

  const separatorIndex = baseName.indexOf("-");
  if (separatorIndex > 0) {
    const rawDate = baseName.slice(0, separatorIndex).trim();
    return {
      title: baseName.slice(separatorIndex + 1).replace(/_/g, " ").trim(),
      date: rawDate,
      dateLabel: rawDate
    };
  }

  return {
    title: baseName.replace(/_/g, " ").trim(),
    date: "",
    dateLabel: ""
  };
}

function kindFromKey(key: string) {
  const extension = key.split(".").pop()?.toLowerCase() || "";
  if (photoExtensions.has(extension)) return "photo";
  if (videoExtensions.has(extension)) return "video";
  return null;
}

type DirectoryConfig = {
  grade: string;
  time: string;
  prefix: string;
};

type CosObject = {
  Key?: string;
  LastModified?: string;
};

export function memoriesFromObjects(objects: CosObject[], directory: DirectoryConfig) {
  const memories = [];
  const eventAlbums = new Map<string, {
    id: string;
    folderName: string;
    items: Array<{
      id: string;
      kind: "photo" | "video";
      src: string;
      title: string;
      frameAt: number;
      lastModified: string;
    }>;
  }>();

  for (const object of objects) {
    const key = object.Key;
    const kind = typeof key === "string" ? kindFromKey(key) : null;
    if (!key || !key.startsWith(directory.prefix) || key.endsWith("/") || !kind) continue;

    const relativeKey = key.slice(directory.prefix.length);
    const segments = relativeKey.split("/").filter(Boolean);
    if (!segments.length) continue;

    const item = {
      id: key,
      kind,
      src: publicObjectUrl(key),
      title: metadataFromKey(key).title,
      frameAt: 2.5,
      lastModified: object.LastModified || ""
    };

    if (segments.length === 1) {
      memories.push({
        ...item,
        ...metadataFromKey(key),
        grade: directory.grade,
        time: directory.time
      });
      continue;
    }

    const folderPath = segments.slice(0, -1).join("/");
    const albumId = `${directory.prefix}${folderPath}/`;
    const existingAlbum = eventAlbums.get(albumId) || {
      id: albumId,
      folderName: segments.at(-2) || folderPath,
      items: []
    };
    existingAlbum.items.push(item);
    eventAlbums.set(albumId, existingAlbum);
  }

  for (const album of eventAlbums.values()) {
    album.items.sort((left, right) =>
      left.id.localeCompare(right.id, "zh-CN", { numeric: true, sensitivity: "base" })
    );
    const photoCount = album.items.filter((item) => item.kind === "photo").length;
    const videoCount = album.items.length - photoCount;
    const lastModified = album.items.reduce(
      (latest, item) => item.lastModified > latest ? item.lastModified : latest,
      ""
    );

    memories.push({
      id: album.id,
      kind: "album",
      ...metadataFromKey(album.folderName, false),
      grade: directory.grade,
      time: directory.time,
      itemCount: album.items.length,
      photoCount,
      videoCount,
      items: album.items,
      lastModified
    });
  }

  return memories;
}

export default async (request: Request, _context: Context) => {
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
      const directoryObjects: CosObject[] = [];
      let marker = "";
      let hasMore = true;

      while (hasMore) {
        const page = await getBucketPage(directory.prefix, marker, secretId, secretKey);
        const objects = !page.Contents
          ? []
          : Array.isArray(page.Contents) ? page.Contents : [page.Contents];

        directoryObjects.push(...objects);

        hasMore = page.IsTruncated === true || page.IsTruncated === "true";
        marker = page.NextMarker || objects.at(-1)?.Key || "";
        if (hasMore && !marker) break;
      }

      memories.push(...memoriesFromObjects(directoryObjects, directory));
    }

    memories.sort((left, right) =>
      left.id.localeCompare(right.id, "zh-CN", { numeric: true, sensitivity: "base" })
    );

    return jsonResponse({
      bucket: BUCKET,
      region: REGION,
      count: memories.length,
      assetCount: memories.reduce(
        (total, memory) => total + (memory.kind === "album" ? memory.itemCount : 1),
        0
      ),
      memories
    });
  } catch (error) {
    console.error("Unable to list COS media", error);
    return jsonResponse({ error: "Unable to read COS media" }, 502);
  }
};

export const config: Config = {
  path: "/api/memories",
  method: ["GET"]
};
