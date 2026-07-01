const BOTS = {
  'poke-post': {
    name: 'Poké-Post',
    githubUrl: 'https://github.com/YOUR_USERNAME/poke-post',
    topggUrl: '',
    discordBotListUrl: '',
    buyMeACoffeeUrl: '',
    supportMessageChance: 1.0,
  },

  relayonme: {
    name: 'RelayOnMe',
    githubUrl: 'https://github.com/YOUR_USERNAME/relayonme',
    topggUrl: '',
    discordBotListUrl: '',
    buyMeACoffeeUrl: '',
    supportMessageChance: 0.2,
  },

  sap: {
    name: 'Selective Auto Publisher',
    githubUrl: 'https://github.com/YOUR_USERNAME/selective-auto-publisher',
    topggUrl: '',
    discordBotListUrl: '',
    buyMeACoffeeUrl: '',
    supportMessageChance: 1.0,
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