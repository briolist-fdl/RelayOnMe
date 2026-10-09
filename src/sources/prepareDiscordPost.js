'use strict';
const { compileRelayFilter } = require('./matchRelayFilter');
const { compileRelayOutput } = require('../output/renderRelayOutput');

function prepareDiscordPost(message, config) {
  const embed = message.embeds?.[0];
  const summary = [message.content || '', embed?.description || '',
    ...(embed?.fields || []).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n');
  const item = { title: embed?.title || '', summary, originalContent: summary,
    author: message.author?.id || '', categories: [], link: embed?.url || message.url || '' };
  const decision = compileRelayFilter(config.content_filter || {}).matches(item);
  if (!decision.matched) return { status: 'filtered', reason: decision.reason };
  try {
    return { status: 'selected', payload: compileRelayOutput(config.output_config || {}).render(item) };
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    return { status: 'invalid_output', reason: 'Check output placeholders, link and the 1,900 character limit.' };
  }
}
module.exports = { prepareDiscordPost };
