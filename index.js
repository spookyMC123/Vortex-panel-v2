/*
██████╗ ██████╗  █████╗  ██████╗ ██████╗ 
██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗
██║  ██║██████╔╝███████║██║     ██║   ██║
██║  ██║██╔══██╗██╔══██║██║     ██║   ██║
██████╔╝██║  ██║██║  ██║╚██████╗╚██████╔╝
╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝            
 */              
/*
*/ 
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const bodyParser = require('body-parser');
const CatLoggr = require('cat-loggr');
const fs = require('node:fs');
const config = require('./config.json')
const ascii = fs.readFileSync('./handlers/ascii.txt', 'utf8');
const app = express();

// ✅ Add this line to fix rate-limit issue when behind a proxy (e.g., cloudflared/nginx)
app.set('trust proxy', true);

const path = require('path');
const chalk = require('chalk');
const expressWs = require('express-ws')(app);
const { db } = require('./handlers/db.js')
const translationMiddleware = require('./handlers/translation');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const theme = require('./storage/theme.json');

const sqlite = require("better-sqlite3");
const SqliteStore = require("better-sqlite3-session-store")(session);
const sessionstorage = new sqlite("sessions.db", { 
  fileMustExist: false,
  verbose: console.log,
  readonly: false
});

// Ensure the database has write permissions and is properly initialized
try {
  // Set proper file permissions
  fs.chmodSync('sessions.db', 0o666);
  
  // Test database write access
  sessionstorage.exec('CREATE TABLE IF NOT EXISTS dummy (id INTEGER)');
  sessionstorage.exec('DROP TABLE IF EXISTS dummy');
  
  console.log('Session database initialized successfully');
} catch (error) {
  console.error('Error initializing session database:', error);
  console.error('Please ensure the application has write permissions to the sessions.db file');
  process.exit(1);
}
const { loadPlugins } = require('./plugins/loadPls.js');
let plugins = loadPlugins(path.join(__dirname, './plugins'));
plugins = Object.values(plugins).map(plugin => plugin.config);
const { init } = require('./handlers/init.js');

const log = new CatLoggr();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(cookieParser())
app.use(translationMiddleware);

const postRateLimiter = rateLimit({
  windowMs: 60 * 100,
  max: 6,
  message: 'Too many requests, please try again later'
});

app.use((req, res, next) => {
  if (req.method === 'POST') {
    postRateLimiter(req, res, next);
  } else {
    next();
  }
});

app.set('view engine', 'ejs');
app.use(
  session({
    store: new SqliteStore({
      client: sessionstorage,
      expired: {
        clear: true,
        intervalMs: 9000000
      }
    }),
    secret: "secret",
    resave: true,
    saveUninitialized: true
  })
);

app.use(async (req, res, next) => {
  try {
    const settings = await db.get('settings');
    res.locals.languages = getlanguages();
    res.locals.ogTitle = config.ogTitle;
    res.locals.ogDescription = config.ogDescription;
    res.locals.footer = settings.footer;
    res.locals.theme = theme;
    next();
  } catch (error) {
    console.error('Error fetching settings:', error);
    next(error);
  }
});

if (config.mode === 'production' || false) {
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '5');
    next();
  });

  app.use('/assets', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=1');
    next();
  });
}

app.use(passport.initialize());
app.use(passport.session());

const pluginRoutes = require('./plugins/pluginmanager.js');
app.use("/", pluginRoutes);
const pluginDir = path.join(__dirname, 'plugins');
const PluginViewsDir = fs.readdirSync(pluginDir).map(addonName => path.join(pluginDir, addonName, 'views'));
app.set('views', [path.join(__dirname, 'views'), ...PluginViewsDir]);

init();

console.log(chalk.gray(ascii) + chalk.white(`version v${config.version}\n`));

const routesDir = path.join(__dirname, 'routes');

function getlanguages() {
  return fs.readdirSync(__dirname + '/lang').map(file => file.split('.')[0])
}

function getlangname() {
  return fs.readdirSync(path.join(__dirname, '/lang')).map(file => {
    const langFilePath = path.join(__dirname, '/lang', file);
    const langFileContent = JSON.parse(fs.readFileSync(langFilePath, 'utf-8'));
    return langFileContent.langname;
  });
}

app.get('/setLanguage', async (req, res) => {
  const lang = req.query.lang;
  if (lang && (await getlanguages()).includes(lang)) {
      res.cookie('lang', lang, { maxAge: 90000000, httpOnly: true, sameSite: 'strict' });
      req.user.lang = lang;
      res.json({ success: true });
  } else {
      res.json({ success: false });
  }
});

function loadRoutes(directory) {
  fs.readdirSync(directory).forEach(file => {
    const fullPath = path.join(directory, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      loadRoutes(fullPath);
    } else if (stat.isFile() && path.extname(file) === '.js') {
      const route = require(fullPath);
      expressWs.applyTo(route);
      app.use("/", route);
    }
  });
}

loadRoutes(routesDir);

app.use(express.static('public'));
app.listen(config.port, () => log.info(`Vortex-panel is listening on port ${config.port}`));

app.get('*', async function(req, res){
  res.render('errors/404', {
    req,
    name: await db.get('name') || 'Vortex-panel',
    logo: await db.get('logo') || false
  })
});
