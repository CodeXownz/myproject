import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, ChannelType } from 'discord.js';
import cron from 'node-cron';

const {
  DISCORD_TOKEN, OWNER_ID, ALLOWLIST_GUILD_ID,
  SANDBOX_CHANNEL_ID, LOG_CHANNEL_ID, OPTIN_ROLE_ID
} = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ---------- Safeties ----------
function ensureOwner(interaction) { return interaction.user.id === OWNER_ID; }
function ensureGuild(interaction) { return interaction.guildId === ALLOWLIST_GUILD_ID; }
function guard(interaction) {
  if (!ensureGuild(interaction)) return 'This command works only in the allow-listed test server.';
  if (!ensureOwner(interaction)) return 'Only the bot owner can run this command.';
  return null;
}

// ---------- Slash commands ----------
const commands = [
  {
    name: 'nuke_safe',
    description: 'Clone sandbox channel and clear recent messages (safe).',
    default_member_permissions: `${PermissionFlagsBits.ManageChannels}`
  },
  {
    name: 'raid_sim',
    description: 'Simulate raid by generating dummy messages into the log channel (safe).'
  },
  {
    name: 'auto_ping',
    description: 'Start or stop scheduled pings to an opt-in role in the sandbox channel.',
    options: [
      { name: 'action', description: 'start or stop', type: 3, required: true, choices: [
        { name: 'start', value: 'start' }, { name: 'stop', value: 'stop' }
      ]},
      { name: 'cron', description: 'Cron expr (default: */5 * * * *)', type: 3, required: false }
    ]
  },
  {
    name: 'ghost_ping_detector',
    description: 'Enable or disable ghost-ping detection logging.',
    options: [
      { name: 'state', description: 'on or off', type: 3, required: true, choices: [
        { name: 'on', value: 'on' }, { name: 'off', value: 'off' }
      ]}
    ]
  }
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Register guild commands to allow-listed guild only
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, ALLOWLIST_GUILD_ID), { body: commands });
  client.user.setActivity('Safe testing only 🛡️');
});

// ---------- Implementations ----------
let autoPingTask = null;
let ghostDetectorOn = true;

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const err = guard(interaction);
  if (err) return interaction.reply({ content: err, ephemeral: true });

  if (interaction.commandName === 'nuke_safe') {
    // Only acts in a single sandbox channel you specified
    const chan = interaction.guild.channels.cache.get(SANDBOX_CHANNEL_ID);
    if (!chan || chan.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Sandbox channel not found or not text.', ephemeral: true });
    }
    await interaction.reply({ content: `Cloning and clearing **#${chan.name}**…`, ephemeral: true });
    // Clone + clear last 100 messages (safe scope)
    const clone = await chan.clone({ reason: 'nuke_safe' });
    await clone.setPosition(chan.position);
    await chan.bulkDelete(100, true).catch(() => {});
    await interaction.followUp({ content: `Done. Clone created: <#${clone.id}>. Last 100 messages cleared in sandbox.` , ephemeral: true });
  }

  if (interaction.commandName === 'raid_sim') {
    const log = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!log || log.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Log channel not found.', ephemeral: true });
    }
    await interaction.reply({ content: 'Generating 25 dummy “raid” messages in log channel…', ephemeral: true });
    for (let i = 1; i <= 25; i++) {
      await log.send(`[SIM] Raid message ${i} — this is a harmless test message.`);
    }
    await log.send('Simulation complete. No real users pinged.');
  }

  if (interaction.commandName === 'auto_ping') {
    const action = interaction.options.getString('action');
    const cronExpr = interaction.options.getString('cron') || '*/5 * * * *'; // every 5 minutes
    const chan = interaction.guild.channels.cache.get(SANDBOX_CHANNEL_ID);
    if (!chan) return interaction.reply({ content: 'Sandbox channel not found.', ephemeral: true });

    if (action === 'start') {
      if (autoPingTask) autoPingTask.stop();
      autoPingTask = cron.schedule(cronExpr, async () => {
        await chan.send(`<@&${OPTIN_ROLE_ID}> scheduled check-in (safe auto-ping).`);
      });
      return interaction.reply({ content: `Auto-ping started with cron \`${cronExpr}\`.`, ephemeral: true });
    } else {
      if (autoPingTask) { autoPingTask.stop(); autoPingTask = null; }
      return interaction.reply({ content: 'Auto-ping stopped.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'ghost_ping_detector') {
    const state = interaction.options.getString('state');
    ghostDetectorOn = state === 'on';
    return interaction.reply({ content: `Ghost-ping detector **${ghostDetectorOn ? 'ENABLED' : 'DISABLED'}**.`, ephemeral: true });
  }
});

// Detect ghost-pings: message mentioned someone then author deletes fast
const recentMentions = new Map(); // messageId -> { guildId, authorId, mentions }
client.on('messageCreate', (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (!ghostDetectorOn) return;
  const hasMentions = msg.mentions.users.size || msg.mentions.roles.size || msg.mentions.everyone;
  if (hasMentions) {
    recentMentions.set(msg.id, {
      guildId: msg.guildId,
      authorId: msg.author.id,
      mentions: {
        users: [...msg.mentions.users.keys()],
        roles: [...msg.mentions.roles.keys()],
        everyone: msg.mentions.everyone
      },
      ts: Date.now()
    });
    // Clean up after 2 minutes
    setTimeout(() => recentMentions.delete(msg.id), 120000);
  }
});

client.on('messageDelete', async (msg) => {
  if (!msg.guild || !ghostDetectorOn) return;
  const rec = recentMentions.get(msg.id);
  if (!rec) return;
  const log = msg.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (!log) return;
  await log.send(
    `👻 **Ghost-ping suspected** by <@${rec.authorId}>. Mentions: users=${rec.mentions.users.length} roles=${rec.mentions.roles.length} everyone=${rec.mentions.everyone ? 'yes' : 'no'}`
  );
});

client.login(DISCORD_TOKEN);
