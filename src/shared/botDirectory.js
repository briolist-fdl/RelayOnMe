const BOTS = {
  'poke-post': {
    name: 'Poké-Post',
    githubUrl: 'https://github.com/briolist-fdl/poke-post',
    topggUrl: '',
    discordBotListUrl: '',
    buyMeACoffeeUrl: 'https://buymeacoffee.com/andreasviken',
    supportMessageChance: 1.0,
  },

  relayonme: {
    name: 'RelayOnMe',
    githubUrl: 'https://github.com/briolist-fdl/relayonme',
    topggUrl: '',
    discordBotListUrl: '',
    buyMeACoffeeUrl: 'https://buymeacoffee.com/andreasviken',
    supportMessageChance: 0.33,
  },

  sap: {
    name: 'Selective Auto Publisher',
    githubUrl: 'https://github.com/briolist-fdl/selective-auto-publisher',
    topggUrl: '',
    discordBotListUrl: '',
    buyMeACoffeeUrl: 'https://buymeacoffee.com/andreasviken',
    supportMessageChance: 0.33,
  },
};

function getBotConfig() {
  const botId = process.env.BOT_ID;

  if (!botId) {
    throw new Error('Missing BOT_ID in .env');
  }

  const config = BOTS[botId];

  if (!config) {
    throw new Error(`Unknown BOT_ID: ${botId}`);
  }

  return {
    id: botId,
    ...config,
  };
}

module.exports = {
  BOTS,
  getBotConfig,
};