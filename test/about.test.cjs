'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {buildAbout}=require('../src/shared/about');
test('about links exactly to configured Brio Bots channel',()=>{const result=buildAbout({env:{BRIO_BOTS_GUILD_ID:'123456789012345678',BRIO_BOTS_ABOUT_CHANNEL_ID:'234567890123456789'}});assert.equal(result.configured,true);assert.equal(result.url,'https://discord.com/channels/123456789012345678/234567890123456789');});
test('invalid overrides fall back to the Brio Bots relayonme channel',()=>{const result=buildAbout({env:{BRIO_BOTS_GUILD_ID:'bad',BRIO_BOTS_ABOUT_CHANNEL_ID:'2'}});assert.equal(result.configured,true);assert.equal(result.url,'https://discord.com/channels/1550119459891576852/1557068983184793730');});
