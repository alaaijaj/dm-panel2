require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const DATA = path.join(__dirname, 'data');
const SETTINGS = path.join(DATA, 'settings.json');
const USERS = path.join(DATA, 'panel_users.json');
const LOGS = path.join(DATA, 'activity_logs.json');
const PANEL_PERMS = path.join(DATA, 'panel_perms.json');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

function ensure(file, value) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  }
}

ensure(SETTINGS, {
  appName: 'Iraq Store',
  siteDescription: 'Announcement Control Panel',
  backgroundImageUrl: '',
  blurStrength: 14,
  defaultMentionType: 'none',
  defaultAnnouncementChannelId: '',
  fallbackDeveloperName: 'Alaa Dev',
  fallbackDeveloperUsername: 'iraqstore.dev',
  fallbackDeveloperAvatar: '/static/developer.svg',
  brandPrimary: '#ff2b2b',
  brandSecondary: '#ff8a00'
});

ensure(USERS, [{
  id: '1',
  email: process.env.OWNER_EMAIL || 'owner@example.com',
  password: process.env.OWNER_PASSWORD || 'ChangeMe123!',
  role: 'owner',
  discordUserId: process.env.OWNER_DISCORD_ID || '',
  isActive: true
}]);

ensure(LOGS, []);
ensure(PANEL_PERMS, {});

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');

function addLog(entry) {
  const logs = read(LOGS);
  logs.unshift({
    id: String(Date.now()),
    time: new Date().toISOString(),
    ...entry
  });
  write(LOGS, logs.slice(0, 1500));
}

function clean(v = '') {
  return String(v).trim();
}

function me(req) {
  return read(USERS).find(u => u.id === req.session.userId) || null;
}

function auth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function ownerOrAdmin(req, res, next) {
  const user = me(req);
  if (!user || !['owner', 'admin'].includes(user.role)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

function owner(req, res, next) {
  const user = me(req);
  if (!user || user.role !== 'owner') {
    return res.status(403).send('Forbidden');
  }
  next();
}

function logoPath() {
  const png = path.join(__dirname, 'public', 'logo.png');
  return fs.existsSync(png) ? '/static/logo.png' : '/static/logo.svg';
}

async function developerProfile() {
  const s = read(SETTINGS);
  const fallback = {
    displayName: s.fallbackDeveloperName || 'Alaa Dev',
    username: s.fallbackDeveloperUsername || 'iraqstore.dev',
    avatar: s.fallbackDeveloperAvatar || '/static/developer.svg'
  };

  const developerId = clean(process.env.DEVELOPER_DISCORD_ID);
  if (!developerId) return fallback;

  try {
    const user = await client.users.fetch(developerId, { force: true });
    return {
      displayName: user.globalName || user.displayName || user.username || fallback.displayName,
      username: user.username || fallback.username,
      avatar: user.displayAvatarURL({ extension: 'png', size: 512 }) || fallback.avatar
    };
  } catch (err) {
    return fallback;
  }
}

app.locals.logoPath = logoPath;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 12
  }
}));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 400 }));

async function guildChoices() {
  return client.guilds.cache
    .map(g => ({ id: g.id, name: g.name, members: g.memberCount || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const guildDataCache = new Map();

async function guildData(gid) {
  const now = Date.now();
  const cached = guildDataCache.get(gid);
  if (cached && (now - cached.time) < 30000) return cached.data;

  const guild = await client.guilds.fetch(gid);
  await guild.channels.fetch();

  const roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name, count: r.members.size }));

  const channels = guild.channels.cache
    .filter(c => c.type === 0)
    .map(c => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const data = { guild, roles, channels };
  guildDataCache.set(gid, { time: now, data });
  return data;
}

async function canUserAnnounceInGuild(req, guildId) {
  const currentUser = me(req);
  if (!currentUser) return false;
  if (currentUser.role === 'owner') return true;

  const perms = read(PANEL_PERMS);
  const requiredRoleId = perms[guildId];
  if (!requiredRoleId || !currentUser.discordUserId) return false;

  try {
    const guild = await client.guilds.fetch(guildId);
    const members = await guild.members.fetch();
    const member = members.get(currentUser.discordUserId);
    if (!member) return false;
    return member.roles.cache.has(requiredRoleId);
  } catch {
    return false;
  }
}

function buildMentionText(type, roleId) {
  if (type === 'everyone') return '@everyone';
  if (type === 'here') return '@here';
  if (type === 'role' && roleId) return `<@&${roleId}>`;
  return '';
}

function buildAnnouncementPayload(body) {
  const mentionText = buildMentionText(clean(body.mentionType), clean(body.mentionRoleId));
  const imageUrl = clean(body.imageUrl);

  if (body.useEmbed === 'on') {
    const embed = new EmbedBuilder()
      .setColor(clean(body.color || '#ff2b2b'))
      .setDescription(clean(body.description) || ' ')
      .setTimestamp();

    if (clean(body.title)) embed.setTitle(clean(body.title));
    if (clean(body.footer)) embed.setFooter({ text: clean(body.footer) });
    if (imageUrl) embed.setImage(imageUrl);

    const payload = { embeds: [embed] };
    if (mentionText || clean(body.plainText)) {
      payload.content = [mentionText, clean(body.plainText)].filter(Boolean).join('\n');
    }
    return payload;
  }

  return {
    content: [mentionText, clean(body.plainText), clean(body.description)].filter(Boolean).join('\n') || ' '
  };
}

app.get('/login', async (req, res) => {
  res.render('login', {
    error: null,
    settings: read(SETTINGS),
    developer: await developerProfile()
  });
});

app.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = clean(req.body.password);

  const user = read(USERS).find(
    u => clean(u.email).toLowerCase() === email &&
         clean(u.password) === password &&
         u.isActive
  );

  if (!user) {
    return res.render('login', {
      error: 'بيانات الدخول غير صحيحة.',
      settings: read(SETTINGS),
      developer: await developerProfile()
    });
  }

  req.session.userId = user.id;
  addLog({ type: 'login', actorEmail: user.email, message: 'Panel login success' });
  res.redirect('/');
});

app.get('/logout', auth, (req, res) => {
  const user = me(req);
  if (user) addLog({ type: 'logout', actorEmail: user.email, message: 'Panel logout' });
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', auth, ownerOrAdmin, async (req, res) => {
  res.render('dashboard', {
    currentUser: me(req),
    settings: read(SETTINGS),
    guilds: await guildChoices(),
    logs: read(LOGS).slice(0, 40),
    users: read(USERS),
    developer: await developerProfile(),
    panelPerms: read(PANEL_PERMS),
    result: null
  });
});

app.get('/guild-data/:gid', auth, ownerOrAdmin, async (req, res) => {
  try {
    const d = await guildData(req.params.gid);
    res.json({
      ok: true,
      roles: d.roles,
      channels: d.channels,
      guildName: d.guild.name
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/announce', auth, ownerOrAdmin, upload.single('image'), async (req, res) => {
  const currentUser = me(req);
  const guildId = clean(req.body.guildId);
  const channelId = clean(req.body.channelId);

  if (!(await canUserAnnounceInGuild(req, guildId))) {
    return res.render('dashboard', {
      currentUser,
      settings: read(SETTINGS),
      guilds: await guildChoices(),
      logs: read(LOGS).slice(0, 40),
      users: read(USERS),
      developer: await developerProfile(),
      panelPerms: read(PANEL_PERMS),
      result: { error: 'ليس لديك صلاحية الإعلانات في هذا السيرفر.' }
    });
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    const channel = guild.channels.cache.get(channelId);
    if (!channel) throw new Error('قناة الإعلانات غير موجودة.');

    const imageUrl = req.file
      ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`
      : clean(req.body.imageUrl);

    const payload = buildAnnouncementPayload({ ...req.body, imageUrl });
    await channel.send(payload);

    addLog({
      type: 'announcement_send',
      actorEmail: currentUser.email,
      guildId,
      channelId,
      title: clean(req.body.title),
      plainTextPreview: clean(req.body.plainText || req.body.description).slice(0, 160)
    });

    res.render('dashboard', {
      currentUser,
      settings: read(SETTINGS),
      guilds: await guildChoices(),
      logs: read(LOGS).slice(0, 40),
      users: read(USERS),
      developer: await developerProfile(),
      panelPerms: read(PANEL_PERMS),
      result: { success: true, message: 'تم إرسال الإعلان بنجاح.' }
    });
  } catch (err) {
    res.render('dashboard', {
      currentUser,
      settings: read(SETTINGS),
      guilds: await guildChoices(),
      logs: read(LOGS).slice(0, 40),
      users: read(USERS),
      developer: await developerProfile(),
      panelPerms: read(PANEL_PERMS),
      result: { error: err.message }
    });
  }
});

app.post('/panel-perms/save', auth, owner, (req, res) => {
  const perms = read(PANEL_PERMS);
  const guildId = clean(req.body.guildId);
  const roleId = clean(req.body.roleId);

  if (guildId && roleId) {
    perms[guildId] = roleId;
    write(PANEL_PERMS, perms);
    addLog({
      type: 'panel_perm_save',
      actorEmail: me(req).email,
      message: `Set announcer role for guild ${guildId}`
    });
  }
  res.redirect('/');
});

app.post('/users/add', auth, owner, (req, res) => {
  const u = read(USERS);
  u.push({
    id: String(Date.now()),
    email: clean(req.body.email).toLowerCase(),
    password: clean(req.body.password),
    role: clean(req.body.role) || 'admin',
    discordUserId: clean(req.body.discordUserId),
    isActive: true
  });
  write(USERS, u);
  res.redirect('/');
});

app.post('/users/toggle/:id', auth, owner, (req, res) => {
  const u = read(USERS);
  const t = u.find(x => x.id === req.params.id);
  if (t) t.isActive = !t.isActive;
  write(USERS, u);
  res.redirect('/');
});

app.post('/settings', auth, owner, (req, res) => {
  const s = read(SETTINGS);
  s.appName = 'Iraq Store';
  s.siteDescription = clean(req.body.siteDescription) || s.siteDescription;
  s.backgroundImageUrl = clean(req.body.backgroundImageUrl);
  s.blurStrength = Number(req.body.blurStrength || s.blurStrength || 14);
  s.defaultMentionType = clean(req.body.defaultMentionType || s.defaultMentionType || 'none');
  s.defaultAnnouncementChannelId = clean(req.body.defaultAnnouncementChannelId || s.defaultAnnouncementChannelId || '');
  write(SETTINGS, s);
  res.redirect('/');
});

client.once('ready', () => {
  console.log(`Iraq Store announcement bot logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);
app.listen(PORT, () => console.log(`Iraq Store Panel: http://localhost:${PORT}`));
