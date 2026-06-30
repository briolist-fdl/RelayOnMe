const { relayOrEditMessage } = require("../relayEngine");

const WEBHOOK_NAME = "RelayOnMe Campfire";

const NO_ALLOWED_MENTIONS = {
  parse: [],
};

function extractCampfireMeetupId(urlString) {
  if (!urlString) return null;

  try {
    const url = new URL(urlString);

    const pathMatch = url.pathname.match(/\/discover\/meetup\/([^/?#]+)/i);
    if (pathMatch?.[1]) {
      return pathMatch[1];
    }

    const possibleQueryParams = [
      "meetupId",
      "meetup_id",
      "meetup",
      "eventId",
      "event_id",
      "id",
    ];

    for (const param of possibleQueryParams) {
      const value = url.searchParams.get(param);
      if (value) return value;
    }

    const uuidMatch = urlString.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    );

    return uuidMatch?.[0] || null;
  } catch {
    return null;
  }
}

async function fetchRedirectLocation(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "RelayOnMe/1.0",
      },
    });

    return response.headers.get("location");
  } finally {
    clearTimeout(timeout);
  }
}

async function getRedirectLocation(url) {
  try {
    const headLocation = await fetchRedirectLocation(url, "HEAD");
    if (headLocation) return headLocation;
  } catch (error) {
    console.warn("Campfire HEAD redirect lookup failed:", error.message);
  }

  try {
    const getLocation = await fetchRedirectLocation(url, "GET");
    if (getLocation) return getLocation;
  } catch (error) {
    console.warn("Campfire GET redirect lookup failed:", error.message);
  }

  return null;
}

async function resolveFinalUrl(startUrl, maxRedirects = 8) {
  let currentUrl = startUrl;

  for (let i = 0; i < maxRedirects; i += 1) {
    const existingMeetupId = extractCampfireMeetupId(currentUrl);

    if (existingMeetupId) {
      return currentUrl;
    }

    const location = await getRedirectLocation(currentUrl);

    if (!location) {
      return currentUrl;
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  return currentUrl;
}

function normalizeRelayKeyPart(value) {
  return String(value || "unknown")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function createCampfireFallbackRelayKey(parsed) {
  const sourceChannelId = normalizeRelayKeyPart(parsed.sourceChannelId);
  const title = normalizeRelayKeyPart(parsed.title);
  const starts = normalizeRelayKeyPart(parsed.starts);
  const location = normalizeRelayKeyPart(parsed.location);

  return `campfire:fallback:${sourceChannelId}:${title}:${starts}:${location}`;
}

async function createCampfireRelayKey(parsed) {
  const directMeetupId = extractCampfireMeetupId(parsed.meetupUrl);

  if (directMeetupId) {
    return `campfire:meetup:${directMeetupId}`;
  }

  try {
    const finalUrl = await resolveFinalUrl(parsed.meetupUrl);
    const resolvedMeetupId = extractCampfireMeetupId(finalUrl);

    if (resolvedMeetupId) {
      console.log("Resolved Campfire meetup ID:", resolvedMeetupId);
      return `campfire:meetup:${resolvedMeetupId}`;
    }

    console.warn("Could not resolve stable Campfire meetup ID. Using fallback key.");
    console.warn("Campfire URL:", parsed.meetupUrl);
    console.warn("Resolved URL:", finalUrl);
  } catch (error) {
    console.warn("Campfire relay key resolution failed:", error.message);
  }

  return createCampfireFallbackRelayKey(parsed);
}

function insertCampfireGroupMention(content, parsed, campfireGroupRoleId) {
  if (!campfireGroupRoleId) {
    return content;
  }

  const mention = `<@&${campfireGroupRoleId}>`;
  const originalContent = content || "";

  if (parsed.type === "created") {
    const replaced = originalContent.replace(
      /(A Campfire meetup was created)(!?)(.*)$/i,
      `$1 in ${mention}$2$3`
    );

    return replaced === originalContent
      ? `${mention} ${originalContent}`.trim()
      : replaced;
  }

  if (parsed.type === "updated") {
    const replaced = originalContent.replace(
      /(A Campfire meetup was updated)(!?)(.*)$/i,
      `$1 in ${mention}$2$3`
    );

    return replaced === originalContent
      ? `${mention} ${originalContent}`.trim()
      : replaced;
  }

  if (parsed.type === "starting_soon") {
    const replaced = originalContent.replace(
      /(A Campfire meetup)( is starting soon)(!?)(.*)$/i,
      `$1 in ${mention}$2$3$4`
    );

    return replaced === originalContent
      ? `${mention} ${originalContent}`.trim()
      : replaced;
  }

  return `${mention} ${originalContent}`.trim();
}

function getCreateAllowedMentions(parsed, campfireGroupRoleId) {
  if (parsed.type !== "created") {
    return NO_ALLOWED_MENTIONS;
  }

  if (!campfireGroupRoleId) {
    return NO_ALLOWED_MENTIONS;
  }

  return {
    parse: [],
    roles: [campfireGroupRoleId],
  };
}

async function relayCampfireMeetup(parsed, message, client, config) {
  const targetChannel = await client.channels.fetch(config.target_channel_id);

  if (!targetChannel) {
    console.log("Target channel not found");
    return;
  }

  const webhooks = await targetChannel.fetchWebhooks();
  let webhook = webhooks.find((hook) => hook.name === WEBHOOK_NAME);

  if (!webhook) {
    webhook = await targetChannel.createWebhook({
      name: WEBHOOK_NAME,
      reason: "RelayOnMe needs a webhook to mirror Campfire meetup posts",
    });
  }

  const campfireGroupRoleId = config.campfire_group_role_id || null;

  const payload = {
    content: insertCampfireGroupMention(
      message.content,
      parsed,
      campfireGroupRoleId
    ),
    username: "Campfire",
    avatarURL: message.author.displayAvatarURL(),
    embeds: message.embeds,
    components: message.components,
  };

  const relayKey = await createCampfireRelayKey(parsed);

  console.log("Relay key:", relayKey);

  await relayOrEditMessage({
    webhook,
    relayKey,
    payload,
    createAllowedMentions: getCreateAllowedMentions(parsed, campfireGroupRoleId),
    editAllowedMentions: NO_ALLOWED_MENTIONS,
    metadata: {
      targetChannelId: targetChannel.id,
      sourceMessageId: parsed.sourceMessageId,
      sourceChannelId: parsed.sourceChannelId,
      lastType: parsed.type,
    },
  });
}

module.exports = {
  relayCampfireMeetup,
  createCampfireRelayKey,
};
