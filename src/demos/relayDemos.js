'use strict';

const { compileRelayFilter } = require('../sources/matchRelayFilter');
const { compileRelayOutput } = require('../output/renderRelayOutput');

// Synthetic examples: no external feed, webhook secret or Discord messages.
const demos = {
  news: {
    name: 'Selected news', source: 'RSS', description: 'Only community news, sponsored posts are excluded.',
    filter: { includeCategories: ['community'], excludeKeywords: ['sponsored'] },
    output: { prefix: '📰 **Community news**', template: '**{title}**\n{summary}\n<{url}>' },
    items: [
      { title: 'Library opens a makerspace', summary: 'Free workshops every Saturday.', categories: ['Community'], link: 'https://example.com/library' },
      { title: 'Sponsored community offer', summary: 'A paid promotion.', categories: ['Community'], link: 'https://example.com/offer' },
      { title: 'National finance report', summary: 'Market news.', categories: ['Finance'], link: 'https://example.com/finance' },
    ],
  },
  jobs: {
    name: 'Relevant job openings', source: 'RSS', description: 'Only remote developer jobs, internships are excluded.',
    filter: { includeCategories: ['remote'], includeKeywords: ['developer'], excludeKeywords: ['internship'] },
    output: { prefix: '💼 **New remote opportunity**', template: '**{title}**\n{summary}\nApply: <{url}>', suffix: '*Shared by the community job feed.*' },
    items: [
      { title: 'Backend developer — remote', summary: 'Help build community tools.', categories: ['Remote'], link: 'https://example.com/jobs/backend' },
      { title: 'Developer internship', summary: 'Summer internship.', categories: ['Remote'], link: 'https://example.com/jobs/intern' },
      { title: 'Office-based developer', summary: 'On site.', categories: ['Office'], link: 'https://example.com/jobs/office' },
    ],
  },
  releases: {
    name: 'Stable releases', source: 'Webhook', description: 'Release events pass, prereleases and issue notifications are skipped.',
    filter: { includeCategories: ['release'], excludeCategories: ['prerelease'] },
    output: { prefix: '🚀 **A new release is available**', template: '**{title}**\n{summary}\nRelease notes: <{url}>' },
    items: [
      { title: 'Community Tool v2.0', summary: 'Improved setup and notification controls.', categories: ['Release'], link: 'https://example.com/releases/v2' },
      { title: 'Community Tool v2.1 beta', summary: 'Early testing build.', categories: ['Release', 'Prerelease'], link: 'https://example.com/releases/beta' },
      { title: 'Issue opened', summary: 'A feature request.', categories: ['Issue'], link: 'https://example.com/issues/1' },
    ],
  },
  events: {
    name: 'Local events', source: 'Community add-on', description: 'Local public events pass, private events are skipped.',
    filter: { includeCategories: ['local'], excludeCategories: ['private'] },
    output: { prefix: '📍 **Upcoming community activity**', template: '**{title}**\n{starts} · {location}\n<{url}>', suffix: '**Bring a friend!**' },
    items: [
      { title: 'Saturday community walk', summary: 'Everyone is welcome.', starts: 'Saturday, 12:00', location: 'Town square', categories: ['Local'], link: 'https://example.com/events/walk' },
      { title: 'Private planning meeting', summary: 'Organizers only.', categories: ['Local', 'Private'], link: 'https://example.com/events/planning' },
      { title: 'Event in another region', summary: 'Out of town.', categories: ['Regional'], link: 'https://example.com/events/other' },
    ],
  },
};

function buildRelayDemo(id, override = {}) {
  if (!Object.hasOwn(demos, id)) throw new TypeError('Unknown demo');
  const demo = demos[id];
  const filter = compileRelayFilter(demo.filter);
  const results = demo.items.map(item => ({ item, ...filter.matches(item) }));
  const selected = results.filter(result => result.matched);
  const config = { ...demo.output, ...override, roleIds: [] }; // Previews never ping.
  const output = compileRelayOutput(config).render(selected[0].item);
  return {
    embeds: [{ title: demo.name, description: demo.description,
      fields: [{ name: 'Before', value: results.map(result => `${result.matched ? '✓' : '✗'} ${result.item.title}`).join('\n') },
        { name: 'After', value: output.content.length <= 1024 ? output.content : output.content.slice(0, 1000) + '\n…' }],
      footer: { text: 'Sample messages. Only you can see this.' } }],
    allowedMentions: { parse: [] },
  };
}

module.exports = { buildRelayDemo };
