'use strict';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const BRIO_BOTS_GUILD_ID = '1550119459891576852';
const BRIO_BOTS_ABOUT_CHANNEL_ID = '1557068983184793730';

function buildAbout({ env = process.env } = {}) {
  const guildId = snowflake(env.BRIO_BOTS_GUILD_ID) ? env.BRIO_BOTS_GUILD_ID : BRIO_BOTS_GUILD_ID;
  const channelId = snowflake(env.BRIO_BOTS_ABOUT_CHANNEL_ID) ? env.BRIO_BOTS_ABOUT_CHANNEL_ID : BRIO_BOTS_ABOUT_CHANNEL_ID;
  const base = 'RelayOnMe forwards approved source messages between configured channels.';
  if (!snowflake(guildId) || !snowflake(channelId)) return { configured:false, content:base };
  const url = `https://discord.com/channels/${guildId}/${channelId}`;
  return { configured:true, url, content:`${base}\n\nHelp and updates: ${url}` };
}
module.exports={buildAbout,BRIO_BOTS_GUILD_ID,BRIO_BOTS_ABOUT_CHANNEL_ID};
