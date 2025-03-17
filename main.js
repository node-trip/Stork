import AmazonCognitoIdentity from 'amazon-cognito-identity-js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { accounts } from "./accounts.js";
import { fileURLToPath } from 'url';

// Определяем __filename и __dirname в начале файла
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Инициализируем глобальный счетчик циклов
if (typeof global.cycleCounter === 'undefined') {
    global.cycleCounter = 0;
}

// Проверка режима запуска (с dashboard или без)
const DISABLE_DASHBOARD = global.DISABLE_DASHBOARD === true || process.env.DISABLE_DASHBOARD === 'true';

// Добавляем функцию для случайной задержки из stork_v2
function randomDelay(min, max) {
  // Проверяем параметры и устанавливаем значения по умолчанию
  min = typeof min === 'number' && !isNaN(min) ? min : 5000;
  max = typeof max === 'number' && !isNaN(max) ? max : 15000;
  
  // Убеждаемся, что min не больше max
  if (min > max) {
    [min, max] = [max, min]; // Меняем значения местами
  }
  
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  log(`Подготовлена случайная задержка ${Math.round(delay/1000)} сек`);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// Улучшенная функция повторных попыток с экспоненциальной задержкой
async function retryWithExponentialBackoff(fn, maxRetries = 5, initialDelay = 1000) {
  let retries = 0;
  let lastError = null;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      lastError = error;
      
      // Определяем тип ошибки для более точной обработки
      const isTooManyRequests = error.message.includes("Too many requests") || 
                               (error.response && error.response.status === 429);
      const isNetworkError = error.message.includes("timeout") || 
                            error.message.includes("network") || 
                            error.code === 'ECONNRESET' ||
                            error.code === 'ETIMEDOUT';
      
      // Проверяем, следует ли повторить попытку для данного типа ошибки
      const shouldRetry = isTooManyRequests || isNetworkError || 
                          error.message.includes("429") || error.message.includes("503");
      
      if (retries > maxRetries || !shouldRetry) {
        throw error;
      }
      
      // Экспоненциальная задержка с увеличенным множителем для Too Many Requests
      let delay = initialDelay * Math.pow(2, retries - 1);
      
      // Добавляем случайность (jitter) к задержке ±30%
      const jitter = 0.3;
      delay = delay * (1 + jitter * (Math.random() * 2 - 1));
      
      // Увеличиваем задержку для ошибок с ограничением запросов
      if (isTooManyRequests) {
        delay = delay * 6; // Существенно увеличиваем задержку для 429
        log(`Обнаружено ограничение запросов (429). Увеличенная задержка: ${Math.round(delay / 1000)}с`, "RETRY");
      }
      
      log(`Повторная попытка ${retries}/${maxRetries} через ${Math.round(delay / 1000)}с из-за: ${error.message}`, "RETRY");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Класс для ограничения скорости запросов (из stork_v2)
class RateLimiter {
  constructor(maxConcurrent = 5, intervalMs = 1000) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.intervalMs = intervalMs;
    this.lastRequestTime = 0;
  }

  async schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.intervalMs) {
      setTimeout(() => this.processQueue(), this.intervalMs - timeSinceLastRequest);
      return;
    }

    this.running++;
    const { fn, resolve, reject } = this.queue.shift();
    this.lastRequestTime = Date.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      setTimeout(() => this.processQueue(), this.intervalMs);
    }
  }
}

// Создаем отдельные лимитеры для разных типов запросов
const authRateLimiter = new RateLimiter(3, 2000); // Максимум 3 запроса авторизации каждые 2 секунды
const apiRateLimiter = new RateLimiter(5, 1000); // Максимум 5 запросов к API каждую секунду

// Улучшенный менеджер прокси для аккаунтов (из stork_v2)
class AccountProxyManager {
  constructor() {
    this.accountProxyMap = new Map();
    this.proxies = [];
    this.initialized = false;
    this.proxyMappingsFile = path.join(__dirname, 'proxy-mappings.json');
  }

  loadProxies() {
    try {
      if (!fs.existsSync(config.threads.proxyFile)) {
        log(`Файл прокси не найден в ${config.threads.proxyFile}, создаю пустой файл`, 'WARN');
        fs.writeFileSync(config.threads.proxyFile, '', 'utf8');
        return [];
      }

      const proxyData = fs.readFileSync(config.threads.proxyFile, 'utf8');
      const proxies = proxyData
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      if (proxies.length === 0) {
        log('Не найдено действительных прокси в файле', 'WARN');
        return [];
      }

      log(`Загружено ${proxies.length} прокси из ${config.threads.proxyFile}`);
      return proxies;
    } catch (error) {
      log(`Ошибка при загрузке прокси: ${error.message}`, 'ERROR');
      return [];
    }
  }

  async initialize() {
    if (this.initialized) return;

    this.proxies = this.loadProxies();
    await this.assignProxiesToAccounts();
    this.saveProxyMappings();
    this.initialized = true;
    log(`Прокси-менеджер инициализирован с ${this.accountProxyMap.size} сопоставлениями аккаунт-прокси`);
  }

  async assignProxiesToAccounts() {
    await this.loadProxyMappings();

    if (this.proxies.length === 0) {
      for (const account of accounts) {
        if (!this.accountProxyMap.has(account.username)) {
          this.accountProxyMap.set(account.username, null);
          log(`Аккаунт ${maskEmail(account.username)} будет использовать прямое соединение (без прокси)`);
        }
      }
      return;
    }

    // Отслеживаем использование каждого прокси
    const proxyUsage = new Map();
    for (const proxy of this.proxies) {
      proxyUsage.set(proxy, 0);
    }

    // Подсчитываем текущее использование
    for (const [_, proxy] of this.accountProxyMap.entries()) {
      if (proxy && proxyUsage.has(proxy)) {
        proxyUsage.set(proxy, proxyUsage.get(proxy) + 1);
      }
    }

    // Назначаем прокси аккаунтам, которые еще не имеют прокси
    for (const account of accounts) {
      if (!this.accountProxyMap.has(account.username)) {
        let leastUsedProxy = null;
        let minUsage = Infinity;

        // Находим наименее используемый прокси
        for (const [proxy, count] of proxyUsage.entries()) {
          if (count < minUsage) {
            minUsage = count;
            leastUsedProxy = proxy;
          }
        }

        if (leastUsedProxy) {
          this.accountProxyMap.set(account.username, leastUsedProxy);
          proxyUsage.set(leastUsedProxy, proxyUsage.get(leastUsedProxy) + 1);
          log(`Назначен прокси ${leastUsedProxy} для аккаунта ${maskEmail(account.username)}`);
        } else {
          this.accountProxyMap.set(account.username, null);
          log(`Аккаунт ${maskEmail(account.username)} будет использовать прямое соединение (без прокси)`);
        }
      }
    }
  }

  getProxyForAccount(username) {
    if (!this.initialized) {
      log('Прокси-менеджер не инициализирован, возвращаю null', 'WARN');
      return null;
    }

    const proxy = this.accountProxyMap.get(username);
    log(`Использую ${proxy || 'прямое соединение'} для аккаунта ${maskEmail(username)}`);
    return proxy;
  }

  saveProxyMappings() {
    try {
      const mappings = {};
      for (const [username, proxy] of this.accountProxyMap.entries()) {
        mappings[username] = proxy;
      }

      fs.writeFileSync(this.proxyMappingsFile, JSON.stringify(mappings, null, 2), 'utf8');
      log(`Сохранено ${Object.keys(mappings).length} сопоставлений аккаунт-прокси в ${this.proxyMappingsFile}`);
    } catch (error) {
      log(`Ошибка при сохранении сопоставлений прокси: ${error.message}`, 'ERROR');
    }
  }

  async loadProxyMappings() {
    try {
      if (fs.existsSync(this.proxyMappingsFile)) {
        const data = fs.readFileSync(this.proxyMappingsFile, 'utf8');
        const mappings = JSON.parse(data);
        const validProxies = new Set(this.proxies);

        for (const [username, proxy] of Object.entries(mappings)) {
          if (proxy === null || validProxies.has(proxy)) {
            this.accountProxyMap.set(username, proxy);
          }
        }

        log(`Загружено ${this.accountProxyMap.size} сопоставлений аккаунт-прокси из ${this.proxyMappingsFile}`);
      } else {
        log(`Существующих сопоставлений прокси не найдено, будут созданы новые сопоставления`);
      }
    } catch (error) {
      log(`Ошибка при загрузке сопоставлений прокси: ${error.message}`, 'WARN');
    }
  }
}

// Инициализируем глобальный экземпляр прокси-менеджера
const proxyManager = new AccountProxyManager();

let createDashboard, updateStats, logMessage;
if (!DISABLE_DASHBOARD) {
    try {
        const dashboard = await import('./dashboard.js');
        createDashboard = dashboard.createDashboard;
        updateStats = dashboard.updateStats;
        logMessage = dashboard.logMessage;
    } catch (error) {
        console.error(`Не удалось импортировать dashboard.js: ${error.message}`);
    }
}

// Используем глобальные переменные для совместного использования между потоками
if (typeof global.lastHeartbeat === 'undefined') {
    global.lastHeartbeat = Date.now();
}

if (typeof global.updateHeartbeat === 'undefined') {
    global.updateHeartbeat = function() {
        global.lastHeartbeat = Date.now();
        return global.lastHeartbeat;
    };
}

// Добавим переменную для отслеживания аккаунтов с ошибками
let accountErrorTimes = {};

// Добавляем механизм глобальной очереди обновления токенов
const tokenUpdateQueue = {
    isUpdating: false,
    lastUpdateTime: {},
    minTimeBetweenUpdates: 24 * 60 * 60 * 1000, // Минимум 24 часа между обновлениями для одного аккаунта
    tokenTimesFile: path.join(__dirname, 'token_update_times.json'),
    
    // Загрузка времени последнего обновления из файла
    loadUpdateTimes() {
        try {
            if (fs.existsSync(this.tokenTimesFile)) {
                const data = fs.readFileSync(this.tokenTimesFile, 'utf8');
                this.lastUpdateTime = JSON.parse(data);
                console.log(`[${getFormattedDate()}] [INFO] Загружены времена последнего обновления токенов из файла`);
                
                // Логируем информацию о времени последнего обновления для каждого аккаунта
                Object.keys(this.lastUpdateTime).forEach(account => {
                    const lastTime = new Date(this.lastUpdateTime[account]);
                    const nextUpdate = new Date(this.lastUpdateTime[account] + this.minTimeBetweenUpdates);
                    console.log(`[${getFormattedDate()}] [INFO] Аккаунт ${maskEmail(account)}: последнее обновление ${lastTime.toISOString()}, следующее обновление ${nextUpdate.toISOString()}`);
                });
            } else {
                console.log(`[${getFormattedDate()}] [INFO] Файл с временами обновления токенов не найден, используем пустой список`);
                this.lastUpdateTime = {};
            }
        } catch (error) {
            console.error(`[${getFormattedDate()}] [ERROR] Ошибка при загрузке времен обновления токенов: ${error.message}`);
            this.lastUpdateTime = {};
        }
    },
    
    // Сохранение времен обновления в файл
    saveUpdateTimes() {
        try {
            fs.writeFileSync(this.tokenTimesFile, JSON.stringify(this.lastUpdateTime, null, 2), 'utf8');
        } catch (error) {
            log(`Ошибка при сохранении времен обновления токенов: ${error.message}`, 'ERROR');
        }
    },
    
    // Проверка, можно ли обновить токен для данного аккаунта
    canUpdate(username) {
        const now = Date.now();
        const lastUpdate = this.lastUpdateTime[username] || 0;
        
        // Всегда разрешаем обновление, если это первое обновление
        if (lastUpdate === 0) return true;
        
        // Проверяем, прошло ли достаточно времени с последнего обновления
        const timeSinceLastUpdate = now - lastUpdate;
        return timeSinceLastUpdate >= this.minTimeBetweenUpdates;
    },
    
    // Новый метод для принудительного обновления истекших токенов
    canForceUpdate(username, isTokenExpired) {
        // Если токен истек, разрешаем обновление независимо от времени последнего обновления
        if (isTokenExpired === true) {
            return true;
        }
        
        // Иначе используем стандартную проверку
        return this.canUpdate(username);
    },
    
    // Регистрация обновления токена
    registerUpdate(username) {
        this.lastUpdateTime[username] = Date.now();
        this.saveUpdateTimes();
    }
};

// Загружаем времена обновления при старте
tokenUpdateQueue.loadUpdateTimes();

// Обработчики необработанных исключений и отказов промисов
process.on('uncaughtException', (error) => {
    console.error(`[КРИТИЧЕСКАЯ ОШИБКА] Необработанное исключение: ${error.message}`);
    console.error(error.stack);
    
    // Пишем ошибку в файл
    try {
        const errorLogPath = path.join(__dirname, 'error.log');
        const errorMessage = `[${new Date().toISOString()}] Необработанное исключение: ${error.message}\n${error.stack}\n\n`;
        fs.appendFileSync(errorLogPath, errorMessage);
    } catch (e) {
        console.error('Не удалось записать лог ошибки:', e);
    }
    
    // Пытаемся восстановить работу через определенное время
    setTimeout(() => {
        console.log('Перезапуск основного процесса после сбоя...');
        restartBot();
    }, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[КРИТИЧЕСКАЯ ОШИБКА] Необработанный отказ Promise: ${reason}`);
    
    // Пишем ошибку в файл
    try {
        const errorLogPath = path.join(__dirname, 'error.log');
        const errorMessage = `[${new Date().toISOString()}] Необработанный отказ Promise: ${reason}\n\n`;
        fs.appendFileSync(errorLogPath, errorMessage);
    } catch (e) {
        console.error('Не удалось записать лог ошибки:', e);
    }
});

// Обработка завершения процесса
process.on('SIGTERM', () => {
    console.log('Получен сигнал SIGTERM, завершение работы...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Получен сигнал SIGINT (Ctrl+C), завершение работы...');
    process.exit(0);
});

// Добавляем обработку специального сигнала для перезагрузки Dashboard
process.on('SIGUSR1', () => {
    console.log('Получен сигнал SIGUSR1, перезагрузка Dashboard...');
    if (!DISABLE_DASHBOARD) {
        forceDestroyScreen();
        setTimeout(() => {
            setupDashboard();
        }, 2000);
    }
});

// Проверяем аргументы запуска для специальных команд
const processArgs = process.argv.slice(2);
if (processArgs.includes('--reset-dashboard')) {
    console.log('Получена команда для сброса Dashboard...');
    if (!DISABLE_DASHBOARD) {
        // Устанавливаем таймер на сброс Dashboard через 5 секунд после запуска
        setTimeout(() => {
            forceDestroyScreen();
            setTimeout(() => {
                setupDashboard();
            }, 2000);
        }, 5000);
    }
}

let screen, statsTable, logBox;
let dashboardActive = false;

function maskEmail(email) {
    if (!email || !email.includes('@')) return email || 'N/A';
    try {
        const [namePart, domain] = email.split('@');
        if (namePart.length <= 2) {
            return namePart[0] + '***@' + domain;
        } else {
            const visible = namePart.slice(0, 4);
            const masked = namePart.slice(4).replace(/./g, '*');
            return visible + masked + '@' + domain;
        }
    } catch (error) {
        return 'protected-email';
    }
}

function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) {
            log(`Config file not located at ${configPath}, using default settings`, 'WARN');
            const defaultConfig = {
                cognito: {
                    region: 'ap-northeast-1',
                    clientId: '5msns4n49hmg3dftp2tp1t2iuh',
                    userPoolId: 'ap-northeast-1_M22I44OpC',
                    username: '',  // To be filled by user
                    password: ''   // To be filled by user
                },
                stork: {
                    intervalSeconds: 300 // Увеличено до 5 минут для предотвращения Too Many Requests
                },
                threads: {
                    maxWorkers: 10
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
            return defaultConfig;
        }

        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return userConfig;
    } catch (error) {
        console.error(`Error loading config: ${error.message}`);
        throw new Error('Failed to load configuration');
    }
}

const userConfig = loadConfig();
const config = {
    cognito: {
        region: userConfig.cognito?.region || 'ap-northeast-1',
        clientId: userConfig.cognito?.clientId || '5msns4n49hmg3dftp2tp1t2iuh',
        userPoolId: userConfig.cognito?.userPoolId || 'ap-northeast-1_M22I44OpC',
        username: userConfig.cognito?.username || '',
        password: userConfig.cognito?.password || ''
    },
    stork: {
        baseURL: 'https://app-api.jp.stork-oracle.network/v1',
        authURL: 'https://api.jp.stork-oracle.network/auth',
        tokenPath: path.join(__dirname, 'tokens.json'),
        intervalSeconds: userConfig.stork?.intervalSeconds || 300, // По умолчанию 5 минут
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        origin: 'chrome-extension://knnliglhgkmlblppdejchidfihjnockl'
    },
    threads: {
        maxWorkers: userConfig.threads?.maxWorkers || 10,
        proxyFile: path.join(__dirname, 'proxies.txt')
    }
};

function validateConfig() {
    if (!accounts || accounts.length === 0 || !accounts[0]?.username || !accounts[0]?.password) {
        log('CRITICAL: No username or password in accounts.js', 'ERROR');
        log('Please update accounts.txt or run quicksetup to add accounts', 'INFO');
        return false;
    }
    return true;
}

const poolData = {
    UserPoolId: config.cognito.userPoolId,
    ClientId: config.cognito.clientId
};
const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substr(0, 19);
}

function getFormattedDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function log(message, type = 'INFO') {
    try {
        message = message.toString().replace(/[\r\n]+/g, ' ').trim();
        const formatted = `[${getFormattedDate()}] [${type}] ${message}`;
        
        // Если dashboardActive и не в режиме DISABLE_DASHBOARD, пишем в logBox
        if (!DISABLE_DASHBOARD && dashboardActive && logBox) {
            try {
                logMessage(logBox, formatted);
            } catch (error) {
                console.log(formatted); // Резервный метод, если logBox не работает
                dashboardActive = false; // Помечаем дашборд как неактивный
            }
        } else {
            console.log(formatted);
        }
        
        // Записываем логи в файл
        try {
            const logPath = path.join(__dirname, 'bot.log');
            fs.appendFileSync(logPath, formatted + '\n');
        } catch (e) {
            console.error('Не удалось записать лог в файл:', e);
        }
        
        // Обновляем время последнего сердцебиения через глобальную функцию
        global.updateHeartbeat();
    } catch (error) {
        console.error('Ошибка в функции log:', error);
    }
}

function loadProxies() {
    try {
        if (!fs.existsSync(config.threads.proxyFile)) {
            log(`Proxy file absent at ${config.threads.proxyFile}, creating an empty file`, 'WARN');
            fs.writeFileSync(config.threads.proxyFile, '', 'utf8');
            return [];
        }
        const proxyData = fs.readFileSync(config.threads.proxyFile, 'utf8');
        const proxies = proxyData
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
        return proxies;
    } catch (error) {
        log(`Failed to load proxies: ${error.message}`, 'ERROR');
        return [];
    }
}

function getProxyAgent(proxy) {
    if (!proxy) return null;
    
    try {
        if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
            return new HttpsProxyAgent(proxy);
        }
        
        if (proxy.startsWith('socks://') || proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
            return new SocksProxyAgent(proxy);
        }
        
        // Попытка автоматического определения типа прокси, если префикс протокола отсутствует
        if (proxy.includes('@') || proxy.match(/\d+\.\d+\.\d+\.\d+:\d+/)) {
            log(`Proxy without protocol specified: ${proxy}. Assuming HTTP proxy.`, 'WARN');
            return new HttpsProxyAgent(`http://${proxy}`);
        }
        
        throw new Error(`Неподдерживаемый формат прокси: ${proxy}`);
    } catch (error) {
        log(`Ошибка при создании прокси-агента: ${error.message}`, 'ERROR');
        return null;
    }
}

class CognitoAuth {
    constructor(username, password) {
        this.username = username;
        this.password = password;
        this.authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: username, Password: password });
        this.cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: username, Pool: userPool });
    }
    authenticate() {
        return new Promise((resolve, reject) => {
            this.cognitoUser.authenticateUser(this.authenticationDetails, {
                onSuccess: (result) => resolve({
                    accessToken: result.getAccessToken().getJwtToken(),
                    idToken: result.getIdToken().getJwtToken(),
                    refreshToken: result.getRefreshToken().getToken(),
                    expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now()
                }),
                onFailure: (err) => reject(err),
                newPasswordRequired: () => reject(new Error('New password required'))
            });
        });
    }
    refreshSession(refreshToken) {
        const refreshTokenObj = new AmazonCognitoIdentity.CognitoRefreshToken({ RefreshToken: refreshToken });
        return new Promise((resolve, reject) => {
            this.cognitoUser.refreshSession(refreshTokenObj, (err, result) => {
                if (err) reject(err);
                else resolve({
                    accessToken: result.getAccessToken().getJwtToken(),
                    idToken: result.getIdToken().getJwtToken(),
                    refreshToken: refreshToken,
                    expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now()
                });
            });
        });
    }
}

class TokenManager {
    constructor(i) {
        if (!accounts[i]) {
            throw new Error(`Account at index ${i} not found`);
        }
        this.accessToken = null;
        this.refreshToken = null;
        this.idToken = null;
        this.expiresAt = null;
        this.auth = new CognitoAuth(accounts[i].username, accounts[i].password);
        this.username = accounts[i].username;
    }
    
    async getValidToken() {
        // Проверяем, действительно ли токен нуждается в обновлении
        if (this.needsRefresh()) {
            await this.refreshOrAuthenticate();
        }
        return this.accessToken;
    }
    
    isTokenExpired() {
        return Date.now() >= this.expiresAt;
    }
    
    // Новый метод для проверки необходимости обновления токена
    needsRefresh() {
        // Если токена нет или его нет, требуется обновление
        if (!this.accessToken || !this.expiresAt) return true;
        
        // Проверяем, истекает ли токен в ближайшие 12 часов
        const twelveHoursInMs = 12 * 60 * 60 * 1000;
        return (this.expiresAt - Date.now()) < twelveHoursInMs;
    }
    
    async refreshOrAuthenticate() {
        try {
            // Проверяем, можно ли обновить токен для этого аккаунта
            // Используем canForceUpdate, чтобы разрешить обновление истекших токенов
            const isExpired = this.isTokenExpired();
            if (!tokenUpdateQueue.canForceUpdate(this.username, isExpired)) {
                log(`Слишком частое обновление токена для ${maskEmail(this.username)}, пропускаем. Следующее возможное обновление через ${Math.round((tokenUpdateQueue.lastUpdateTime[this.username] + tokenUpdateQueue.minTimeBetweenUpdates - Date.now()) / (1000 * 60 * 60))} часов`, 'WARN');
                // Если токен еще действителен, просто возвращаем текущий токен
                if (this.accessToken && !isExpired) {
                    return;
                } else {
                    // Это условие не должно выполняться, так как мы разрешаем обновление истекших токенов
                    log(`Критическая ошибка логики: токен истек и должен был обновиться`, 'ERROR');
                    throw new Error("Critical logic error in token refresh mechanism");
                }
            }
            
            // Регистрируем обновление
            tokenUpdateQueue.registerUpdate(this.username);
            
            log(`Обновление токена для ${maskEmail(this.username)}...`);
            let result = this.refreshToken
                ? await this.auth.refreshSession(this.refreshToken)
                : await this.auth.authenticate();
            await this.updateTokens(result);
            
            const reason = isExpired ? " (токен истек)" : "";
            log(`Токен для ${maskEmail(this.username)} успешно обновлен${reason}. Следующее обновление возможно через 24 часа`, 'INFO');
        } catch (error) {
            log(`Ошибка при обновлении токена для ${maskEmail(this.username)}: ${error.message}`, 'ERROR');
            throw error;
        }
    }
    
    async updateTokens(result) {
        this.accessToken = result.accessToken;
        this.idToken = result.idToken;
        this.refreshToken = result.refreshToken;
        this.expiresAt = Date.now() + result.expiresIn;
        const tokens = {
            accessToken: this.accessToken,
            idToken: this.idToken,
            refreshToken: this.refreshToken,
            isAuthenticated: true,
            isVerifying: false
        };
        await saveTokens(tokens);
        log('Successfully updated and saved tokens to tokens.json');
    }
}

async function getTokens() {
    try {
        if (!fs.existsSync(config.stork.tokenPath)) {
            throw new Error(`No tokens file found at ${config.stork.tokenPath}`);
        }
        const tokensData = await fs.promises.readFile(config.stork.tokenPath, 'utf8');
        const tokens = JSON.parse(tokensData);
        if (!tokens.accessToken || tokens.accessToken.length < 20) {
            throw new Error('Access token is invalid');
        }
        log(`Read access token: ${tokens.accessToken.substring(0, 10)}...`);
        return tokens;
    } catch (error) {
        log(`Error reading tokens: ${error.message}`, 'ERROR');
        throw error;
    }
}

async function saveTokens(tokens) {
    try {
        await fs.promises.writeFile(config.stork.tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
        log('Tokens have been saved successfully');
        return true;
    } catch (error) {
        log(`Error writing tokens: ${error.message}`, 'ERROR');
        return false;
    }
}

async function refreshTokens(refreshToken) {
    try {
        log('Requesting token refresh via Stork API...');
        const response = await axios({
            method: 'POST',
            url: `${config.stork.authURL}/refresh`,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': config.stork.userAgent,
                'Origin': config.stork.origin
            },
            data: { refresh_token: refreshToken }
        });
        const tokens = {
            accessToken: response.data.access_token,
            idToken: response.data.id_token || '',
            refreshToken: response.data.refresh_token || refreshToken,
            isAuthenticated: true,
            isVerifying: false
        };
        await saveTokens(tokens);
        log('Refreshed token via Stork API');
        return tokens;
    } catch (error) {
        log(`Token refresh attempt failed: ${error.message}`, 'ERROR');
        throw error;
    }
}

async function getSignedPrices(tokens) {
    try {
        log('Gathering signed prices data...');
        return await apiRateLimiter.schedule(async () => {
            const response = await axios({
                method: 'GET',
                url: `${config.stork.baseURL}/stork_signed_prices`,
                headers: {
                    'Authorization': `Bearer ${tokens.accessToken}`,
                    'Content-Type': 'application/json',
                    'Origin': config.stork.origin,
                    'User-Agent': config.stork.userAgent
                },
                timeout: 30000
            });
            const dataObj = response.data.data;
            const result = Object.keys(dataObj).map(assetKey => {
                const assetData = dataObj[assetKey];
                return {
                    asset: assetKey,
                    msg_hash: assetData.timestamped_signature.msg_hash,
                    price: assetData.price,
                    timestamp: new Date(assetData.timestamped_signature.timestamp / 1000000).toISOString(),
                    ...assetData
                };
            });
            log(`Acquired ${result.length} signed prices`);
            return result;
        });
    } catch (error) {
        log(`Error acquiring signed prices: ${error.message}`, 'ERROR');
        throw error;
    }
}

async function sendValidation(tokens, msgHash, isValid, proxy) {
    try {
        const agent = getProxyAgent(proxy);
        
        log(`Отправка валидации для hash: ${msgHash.substring(0, 8)}..., valid=${isValid}, прокси: ${proxy ? proxy : 'прямое соединение'}`, 'DEBUG');
        
        return await apiRateLimiter.schedule(async () => {
            try {
                const response = await axios({
                    method: 'POST',
                    url: `${config.stork.baseURL}/stork_signed_prices/validations`,
                    headers: {
                        'Authorization': `Bearer ${tokens.accessToken}`,
                        'Content-Type': 'application/json',
                        'Origin': config.stork.origin,
                        'User-Agent': config.stork.userAgent
                    },
                    httpsAgent: agent,
                    data: { msg_hash: msgHash, valid: isValid },
                    timeout: 30000 // таймаут 30 секунд
                });
                
                log(`Ответ сервера для валидации ${msgHash.substring(0, 8)}...: статус ${response.status}`, 'DEBUG');
                return response.data;
            } catch (error) {
                // Собираем детальную информацию об ошибке
                const statusCode = error.response ? error.response.status : 'N/A';
                const responseData = error.response && error.response.data ? JSON.stringify(error.response.data).substring(0, 100) : 'N/A';
                
                log(`Ошибка при отправке валидации hash=${msgHash.substring(0, 8)}...: ${error.message}`, 'ERROR');
                log(`Детали ошибки: статус=${statusCode}, ответ=${responseData}`, 'ERROR');
                
                throw error;
            }
        });
    } catch (error) {
        throw error;
    }
}

async function getUserStats(tokens) {
    try {
        log('Retrieving user statistics...');
        return await apiRateLimiter.schedule(async () => {
            const response = await axios({
                method: 'GET',
                url: `${config.stork.baseURL}/me`,
                headers: {
                    'Authorization': `Bearer ${tokens.accessToken}`,
                    'Content-Type': 'application/json',
                    'Origin': config.stork.origin,
                    'User-Agent': config.stork.userAgent
                },
                timeout: 30000
            });
            return response.data.data;
        });
    } catch (error) {
        log(`Error retrieving user stats: ${error.message}`, 'ERROR');
        throw error;
    }
}

function validatePrice(priceData) {
    try {
        // Логируем подробную информацию о проверяемых данных
        log(`Валидация данных: актив=${priceData.asset || 'N/A'}, msg_hash=${priceData.msg_hash?.substring(0, 8) || 'N/A'}...`, 'VALIDATE');
        
        if (!priceData.msg_hash || !priceData.price || !priceData.timestamp) {
            const missing = [];
            if (!priceData.msg_hash) missing.push('msg_hash');
            if (!priceData.price) missing.push('price');
            if (!priceData.timestamp) missing.push('timestamp');
            
            log(`Данные неполные, отсутствуют поля: ${missing.join(', ')}`, 'WARN');
            return false;
        }
        
        // Проверяем timestamp
        const currentTime = Date.now();
        let dataTime;
        
        try {
            dataTime = new Date(priceData.timestamp).getTime();
            if (isNaN(dataTime)) {
                log(`Некорректный формат timestamp: ${priceData.timestamp}`, 'WARN');
                return false;
            }
        } catch (e) {
            log(`Ошибка при анализе timestamp: ${e.message}`, 'ERROR');
            return false;
        }
        
        const timeDiffMinutes = (currentTime - dataTime) / (1000 * 60);
        
        if (timeDiffMinutes > 60) {
            log(`Данные устарели: ${Math.round(timeDiffMinutes)} минут (больше 60 минут)`, 'WARN');
            return false;
        } else {
            log(`Данные актуальны: возраст ${Math.round(timeDiffMinutes)} минут`, 'INFO');
        }
        
        // Проверка цены
        if (isNaN(parseFloat(priceData.price))) {
            log(`Некорректный формат цены: ${priceData.price}`, 'WARN');
            return false;
        }
        
        return true;
    } catch (error) {
        log(`Проверка цены вызвала ошибку: ${error.message}`, 'ERROR');
        return false;
    }
}

// Добавим функцию-обертку для API запросов с повторными попытками и экспоненциальной задержкой
async function retryApiCall(apiCallFn, maxRetries = 3, initialDelay = 15000) {
    let retryCount = 0;
    let lastError = null;

    while (retryCount < maxRetries) {
        try {
            return await apiCallFn();
        } catch (error) {
            lastError = error;
            retryCount++;
            
            if (retryCount >= maxRetries) {
                break;
            }
            
            // Экспоненциальная задержка между попытками - увеличиваем начальную задержку
            const delay = initialDelay * Math.pow(2, retryCount - 1);
            // Добавляем случайность (jitter) к задержке ±30%
            const jitter = 0.3;
            const randomizedDelay = delay * (1 + jitter * (Math.random() * 2 - 1));
            
            // Увеличиваем задержку для ошибок, связанных с ограничением запросов
            const finalDelay = error.message.includes('Too many requests') ? 
                randomizedDelay * 5 : randomizedDelay; // Увеличиваем множитель с 3 до 5
            
            log(`API запрос не удался (попытка ${retryCount}/${maxRetries}). Повторная попытка через ${Math.round(finalDelay/1000)} сек...`, 'WARN');
            await new Promise(resolve => setTimeout(resolve, finalDelay));
        }
    }
    
    throw lastError;
}

if (!isMainThread) {
    // Код для воркера
    const { priceData, tokens, proxy } = workerData;
    async function validateAndSend() {
        try {
            const isValid = validatePrice(priceData);
            
            // Добавляем дополнительное логирование
            parentPort.postMessage({ 
                type: 'log', 
                message: `Worker: Валидация ${isValid ? 'успешна' : 'не успешна'} для ${priceData.asset || 'неизвестного актива'}, msg_hash: ${priceData.msg_hash?.substring(0, 8) || 'N/A'}...` 
            });
            
            // Используем улучшенную функцию повторных попыток
            await retryWithExponentialBackoff(async () => {
                try {
                    const result = await sendValidation(tokens, priceData.msg_hash, isValid, proxy);
                    parentPort.postMessage({ 
                        type: 'log', 
                        message: `Worker: Ответ от сервера для ${priceData.msg_hash?.substring(0, 8) || 'N/A'}...: ${JSON.stringify(result || {}).substring(0, 100)}` 
                    });
                } catch (sendError) {
                    parentPort.postMessage({ 
                        type: 'log', 
                        message: `Worker: Ошибка при отправке валидации: ${sendError.message}, статус: ${sendError.response?.status || 'N/A'}` 
                    });
                    throw sendError; // Пробрасываем для повторной попытки
                }
            }, 3, 2000);
            
            parentPort.postMessage({ success: true, msgHash: priceData.msg_hash, isValid });
        } catch (error) {
            parentPort.postMessage({ 
                type: 'log', 
                message: `Worker: Критическая ошибка: ${error.message}, для hash: ${priceData.msg_hash?.substring(0, 8) || 'N/A'}...` 
            });
            
            parentPort.postMessage({ success: false, error: error.message, msgHash: priceData.msg_hash });
        }
    }
    validateAndSend();

} else {
    // ================== КОД ОСНОВНОГО ПОТОКА ==================
    let jobs = 0; // Счетчик обработанных аккаунтов
    
    async function runValidationProcess(tokenManager) {
        try {
            log('---------- НАЧАЛО ЦИКЛА ВАЛИДАЦИИ ----------');
            
            // Используем randomDelay вместо встроенного решения
            // Уменьшаем задержку до 15-30 секунд для ускорения фарминга
            const delay = await randomDelay(15000, 30000); 
            log(`Добавляем случайную задержку ${delay/1000} сек перед запуском...`);
            
            // Используем улучшенную функцию повторных попыток для получения токенов
            const tokens = await retryWithExponentialBackoff(async () => {
                return await getTokens();
            }, 5, 5000);
            
            // Используем улучшенную функцию для получения данных пользователя
            const initialUserData = await retryWithExponentialBackoff(async () => {
                return await getUserStats(tokens);
            }, 5, 5000);

            if (!initialUserData || !initialUserData.stats) {
                throw new Error('Unable to retrieve initial stats from server');
            }

            // Получаем данные для валидации с использованием улучшенной функции
            const signedPrices = await retryWithExponentialBackoff(async () => {
                return await getSignedPrices(tokens);
            }, 5, 5000);
            
            // Используем прокси из менеджера прокси вместо прямой загрузки
            if (!signedPrices || signedPrices.length === 0) {
                log('No new items found for validation');
                const userData = await getUserStats(tokens);
                displayStats(userData);
                return;
            }

            log(`Processing ${signedPrices.length} items using up to ${config.threads.maxWorkers} workers...`);
            const workers = [];
            const chunkSize = Math.ceil(signedPrices.length / config.threads.maxWorkers);
            const batches = [];
            for (let i = 0; i < signedPrices.length; i += chunkSize) {
                batches.push(signedPrices.slice(i, i + chunkSize));
            }

            for (let i = 0; i < Math.min(batches.length, config.threads.maxWorkers); i++) {
                const batch = batches[i];
                // Получаем прокси для текущего аккаунта из менеджера прокси
                const proxy = proxyManager.getProxyForAccount(tokenManager.username);
                
                batch.forEach(priceData => {
                    workers.push(new Promise((resolve) => {
                        const worker = new Worker(__filename, {
                            workerData: { priceData, tokens, proxy }
                        });
                        worker.on('message', (message) => {
                            // Обрабатываем сообщения логов от воркера
                            if (message.type === 'log') {
                                log(message.message, 'WORKER');
                                return;
                            }
                            // Обрабатываем обычные сообщения о результате
                            resolve(message);
                        });
                        worker.on('error', (error) => resolve({ success: false, error: error.message }));
                        worker.on('exit', (code) => {
                            if (code !== 0) {
                                resolve({ success: false, error: `Worker exited with code ${code}` });
                            } else {
                                resolve({ success: true });
                            }
                        });
                    }));
                });
            }

            const results = await Promise.all(workers);
            const successCount = results.filter(r => r.success).length;
            log(`Completed ${successCount} out of ${results.length} validations successfully`);

            // Анализируем результаты валидации для текущего аккаунта
            const currentUsername = tokenManager.username;
            if (successCount < results.length) {
                // Логируем детали неудачных валидаций
                const failedResults = results.filter(r => !r.success);
                failedResults.forEach((result, index) => {
                    log(`Неудачная валидация #${index + 1}: ${result.error || 'Неизвестная ошибка'}`, 'ERROR');
                    log(`Hash сообщения: ${result.msgHash ? result.msgHash.substring(0, 10) + '...' : 'Нет hash'}`, 'ERROR');
                });
                
                // Запись информации о проблемном аккаунте для дальнейшего анализа
                log(`Аккаунт с проблемами валидации: ${maskEmail(currentUsername)}, успешно: ${successCount}/${results.length}`, 'WARN');
                
                // Записываем детали в файл для будущего анализа
                try {
                    const errorAnalysisPath = path.join(__dirname, 'validation_errors.log');
                    const errorEntry = `[${new Date().toISOString()}] Аккаунт: ${maskEmail(currentUsername)}, Успешно: ${successCount}/${results.length}, Ошибки: ${failedResults.map(r => r.error || 'N/A').join(' | ')}\n`;
                    fs.appendFileSync(errorAnalysisPath, errorEntry);
                } catch (logError) {
                    log(`Не удалось записать данные анализа ошибок: ${logError.message}`, 'ERROR');
                }
            }

            // Получаем обновленные данные пользователя с использованием улучшенной функции
            const updatedUserData = await retryWithExponentialBackoff(async () => {
                return await getUserStats(tokens);
            }, 5, 5000);
            
            const validNow = updatedUserData.stats.stork_signed_prices_valid_count || 0;
            const invalidNow = updatedUserData.stats.stork_signed_prices_invalid_count || 0;

            displayStats(updatedUserData);

            log(`----------- ОТЧЕТ О ВАЛИДАЦИИ -----------`);
            log(`Всего обработано: ${validNow + invalidNow}`);
            log(`Успешных валидаций: ${validNow}`);
            log(`Неудачных валидаций: ${invalidNow}`);
            log('---------------- ЗАВЕРШЕНО ----------------');

            if (jobs < accounts.length) {
                log(`Планирование следующего запуска через 30 сек...`);
                setTimeout(() => main(), 30000); // Уменьшаем с 60 до 30 секунд
            } else {
                jobs = 0;
                global.cycleCounter++;
                log(`Все аккаунты обработаны. Цикл #${global.cycleCounter} завершен. Следующий цикл через ${config.stork.intervalSeconds} сек...`);
                setTimeout(() => main(), config.stork.intervalSeconds * 1000);
            }
        } catch (error) {
            log(`Цикл валидации прерван: ${error.message}`, 'ERROR');
            // Добавляем расширенное логирование ошибок
            if (error.stack) {
                log(`Стек ошибки: ${error.stack}`, 'ERROR');
            }
            if (error.response) {
                log(`Ответ сервера: ${JSON.stringify(error.response.data || {})}`, 'ERROR');
                log(`Статус ошибки: ${error.response.status}`, 'ERROR');
            }
            
            log(`Планирование повторной попытки через ${config.stork.intervalSeconds * 2} сек...`, 'WARN');
            
            // В случае сбоя пытаемся перезапустить процесс через двойной интервал
            setTimeout(() => {
                if (jobs >= accounts.length) {
                    jobs = 0;
                    global.cycleCounter++;
                    log(`Цикл #${global.cycleCounter} начат после сбоя...`);
                }
                main();
            }, config.stork.intervalSeconds * 2000);
        }
    }

    function displayStats(userData) {
        if (!userData || !userData.stats) {
            log('No valid stats found to display', 'WARN');
            return;
        }
        
        const dataForTable = {
            user: maskEmail(userData.email || 'N/A'),
            valid: userData.stats.stork_signed_prices_valid_count || 0,
            invalid: userData.stats.stork_signed_prices_invalid_count || 0,
            lastVerified: userData.stats.stork_signed_prices_last_verified_at || 'Never'
        };
        
        if (!DISABLE_DASHBOARD && dashboardActive && statsTable) {
            try {
                updateStats(statsTable, dataForTable);
            } catch (error) {
                log(`Ошибка при обновлении статистики: ${error.message}`, 'ERROR');
                // Вывод в консоль в случае ошибки
                log(`Пользователь: ${dataForTable.user}`, 'STATS');
                log(`Валидно: ${dataForTable.valid}`, 'STATS');
                log(`Невалидно: ${dataForTable.invalid}`, 'STATS');
                log(`Последняя проверка: ${dataForTable.lastVerified}`, 'STATS');
            }
        } else {
            // Если dashboard отключен или недоступен, выводим в консоль
            log(`----- СТАТИСТИКА ${dataForTable.user} -----`, 'STATS');
            log(`Валидно: ${dataForTable.valid}`, 'STATS');
            log(`Невалидно: ${dataForTable.invalid}`, 'STATS');
            log(`Последняя проверка: ${dataForTable.lastVerified}`, 'STATS');
            log(`------------------------------------------`, 'STATS');
        }
    }

    async function logCurrentIpForAccount(accountIndex) {
        if (!accounts[accountIndex]) {
            log(`Аккаунт с индексом ${accountIndex} не найден`, 'ERROR');
            return;
        }
        
        const username = accounts[accountIndex].username;
        const proxy = proxyManager.getProxyForAccount(username);
        
        try {
            const agent = proxy ? getProxyAgent(proxy) : null;
            const response = await axios.get('https://api.ipify.org?format=json', {
                httpsAgent: agent,
                timeout: 10000
            });
            const currentIp = response.data.ip;
            log(`Current IP for account ${maskEmail(username)}: ${currentIp}`);
        } catch (error) {
            log(`Failed to fetch current IP for account ${maskEmail(username)}: ${error.message}`, 'ERROR');
        }
    }

    async function main() {
        try {
            // Инициализируем прокси-менеджер при первом запуске
            if (!proxyManager.initialized) {
                await proxyManager.initialize();
            }
            
            // Проверяем правильность счетчика jobs
            if (jobs >= accounts.length) {
                log('Сброс счетчика jobs в начале цикла', 'INFO');
                jobs = 0;
            }

            if (!validateConfig()) {
                log('Некорректная конфигурация. Выход из программы.', 'ERROR');
                process.exit(1);
            }

            if (!accounts[jobs]) {
                log('Не найдены аккаунты для работы. Пожалуйста, добавьте аккаунты в accounts.txt', 'ERROR');
                process.exit(1);
            }

            // Проверяем, является ли текущий аккаунт проблемным (nede*********@gmail.com)
            const currentAccount = accounts[jobs].username;
            if (currentAccount.includes("nede") && currentAccount.includes("@gmail.com")) {
                log(`Обнаружен проблемный аккаунт: ${maskEmail(currentAccount)}, включаю расширенную диагностику`, 'WARN');
                // Дополнительное тестирование соединения
                try {
                    const proxy = proxyManager.getProxyForAccount(currentAccount);
                    const agent = proxy ? getProxyAgent(proxy) : null;
                    log(`Тестирование соединения для ${maskEmail(currentAccount)} через ${proxy || 'прямое соединение'}...`, 'INFO');
                    
                    const testResponse = await axios.get('https://api.ipify.org?format=json', {
                        httpsAgent: agent,
                        timeout: 10000
                    });
                    
                    log(`Тест соединения успешен. IP: ${testResponse.data.ip}`, 'INFO');
                    log(`Дополнительная информация о соединении: статус ${testResponse.status}, заголовки: ${JSON.stringify(testResponse.headers).substring(0, 100)}...`, 'DEBUG');
                } catch (testError) {
                    log(`Тест соединения для ${maskEmail(currentAccount)} не удался: ${testError.message}`, 'ERROR');
                    log(`Подробная информация об ошибке: ${JSON.stringify(testError.response || {}).substring(0, 200)}`, 'ERROR');
                }
            }

            // Проверяем, был ли этот аккаунт недавно заблокирован
            const errorTime = accountErrorTimes[currentAccount];
            const now = Date.now();
            
            log(`Обработка аккаунта ${jobs+1}/${accounts.length}: ${maskEmail(currentAccount)}`, 'INFO');
            
            if (errorTime && (now - errorTime) < 15 * 60 * 1000) { // 15 минут блокировки
                const remainingMinutes = Math.ceil((15 * 60 * 1000 - (now - errorTime)) / 60000);
                log(`Аккаунт ${maskEmail(currentAccount)} недавно получил ошибку. Ожидание ${remainingMinutes} минут...`, 'WARN');
                jobs++; // Переходим к следующему аккаунту
                
                // Если следующий аккаунт существует, запускаем main() снова
                if (jobs < accounts.length) {
                    setTimeout(() => main(), 1000); // Быстрый переход к следующему аккаунту
                    return;
                } else {
                    jobs = 0;
                    global.cycleCounter++;
                    log(`Все аккаунты обработаны. Цикл #${global.cycleCounter} завершен. Следующий цикл через ${config.stork.intervalSeconds} сек...`);
                    setTimeout(() => main(), config.stork.intervalSeconds * 1000);
                    return;
                }
            }

            // Используем randomDelay вместо встроенного решения
            // Уменьшаем задержку до 15-30 секунд для ускорения фарминга
            const delay = await randomDelay(15000, 30000); 
            log(`Добавляем случайную задержку ${delay/1000} сек перед запуском...`);

            await logCurrentIpForAccount(jobs);

            const maskedUser = maskEmail(accounts[jobs].username);
            log(`Starting process for user: ${maskedUser}`);

            const tokenManager = new TokenManager(jobs);
            const currentJobIndex = jobs; // Сохраняем текущий индекс для корректной обработки ошибок
            jobs++;

            // Используем улучшенную функцию для получения токена
            await retryWithExponentialBackoff(async () => {
                await tokenManager.getValidToken();
            }, 5, 5000);
            
            log('Sign-in/auth flow completed successfully');
            runValidationProcess(tokenManager);

            // Периодическое обновление токена - увеличиваем интервал до 24 часов
            setInterval(async () => {
                try {
                    // Обновляем токен только если это действительно необходимо
                    if (tokenManager.needsRefresh()) {
                        const isExpired = tokenManager.isTokenExpired();
                        if (tokenUpdateQueue.canForceUpdate(tokenManager.username, isExpired)) {
                            const reason = isExpired ? " (токен истек)" : "";
                            log(`Плановое обновление токена для ${maskEmail(tokenManager.username)}${reason}`);
                            tokenUpdateQueue.registerUpdate(tokenManager.username);
                            
                            // Используем улучшенную функцию для обновления токена
                            await retryWithExponentialBackoff(async () => {
                                await tokenManager.getValidToken();
                            }, 5, 5000);
                            
                            log(`Плановое обновление токена для ${maskEmail(tokenManager.username)} выполнено успешно`);
                        } else {
                            const nextUpdateTime = new Date(tokenUpdateQueue.lastUpdateTime[tokenManager.username] + tokenUpdateQueue.minTimeBetweenUpdates);
                            log(`Плановое обновление токена для ${maskEmail(tokenManager.username)} отложено. Следующее возможное обновление: ${nextUpdateTime.toISOString()}`);
                        }
                    } else {
                        log(`Токен для ${maskEmail(tokenManager.username)} не требует обновления`, 'INFO');
                    }
                } catch (error) {
                    log(`Ошибка при плановом обновлении токена: ${error.message}`, 'ERROR');
                }
            }, 24 * 60 * 60 * 1000); // Обновление каждые 24 часа
        } catch (error) {
            log(`Startup failed: ${error.message}`, 'ERROR');
            
            // Сохраняем индекс аккаунта, вызвавшего ошибку
            const errorAccountIndex = jobs - 1; // Используем jobs - 1, так как jobs уже инкрементирован
            
            // Если ошибка "Too many requests", записываем время для этого аккаунта
            if (error.message.includes('Too many requests') && errorAccountIndex >= 0 && errorAccountIndex < accounts.length) {
                const errorAccount = accounts[errorAccountIndex].username;
                accountErrorTimes[errorAccount] = Date.now();
                log(`Аккаунт ${maskEmail(errorAccount)} временно заблокирован на 15 минут`, 'ERROR');
            }
            
            // Увеличенная задержка для ошибки Too many requests
            const retryDelay = error.message.includes('Too many requests') ? 180000 : 30000; // 3 минуты или 30 секунд
            log(`Попытка перезапуска через ${retryDelay/1000} секунд...`, 'WARN');
            setTimeout(() => {
                if (jobs >= accounts.length) {
                    jobs = 0;
                    global.cycleCounter++;
                    log(`Цикл #${global.cycleCounter} начат после сбоя...`);
                }
                main();
            }, retryDelay);
        }
    }

    // Принудительное уничтожение предыдущего screen
    function forceDestroyScreen() {
        if (screen) {
            try {
                // Очищаем все обработчики событий
                screen.removeAllListeners();
                // Уничтожаем экран
                screen.destroy();
            } catch (e) {
                console.error('Ошибка при принудительном уничтожении screen:', e);
            }
        }
        
        // Сбрасываем все переменные
        screen = null;
        statsTable = null;
        logBox = null;
        dashboardActive = false;
        
        // Очищаем консоль для лучшей визуализации
        console.clear();
        console.log('Dashboard полностью сброшен');
    }

    function setupDashboard() {
        if (DISABLE_DASHBOARD) {
            log('Запуск в режиме без графического интерфейса');
            dashboardActive = false;
            return false;
        }
        
        try {
            // Полностью уничтожаем предыдущий dashboard
            forceDestroyScreen();
            
            console.log('Инициализация нового графического интерфейса...');
            
            // Используем setTimeout для большей уверенности в уничтожении предыдущего dashboard
            setTimeout(() => {
                try {
                    if (createDashboard) {
                        console.log('Создание нового Dashboard интерфейса...');
                        const dashboard = createDashboard();
                        console.log('Dashboard создан, настройка компонентов...');
                        screen = dashboard.screen;
                        statsTable = dashboard.statsTable;
                        logBox = dashboard.logBox;
                        dashboardActive = true;
                        console.log('Dashboard успешно активирован');
                        
                        // Добавляем обработчик ошибок для screen
                        screen.on('destroy', () => {
                            dashboardActive = false;
                            console.log('Dashboard уничтожен, попытка восстановления...');
                            // Увеличиваем задержку перед повторной инициализацией
                            setTimeout(() => {
                                forceDestroyScreen();
                                setupDashboard();
                            }, 10000);
                        });
                    } else {
                        console.error('createDashboard функция недоступна');
                    }
                } catch (error) {
                    console.error('Ошибка при инициализации dashboard:', error);
                    dashboardActive = false;
                }
            }, 1000);
            
            return true;
        } catch (error) {
            console.error('Ошибка при инициализации dashboard:', error);
            dashboardActive = false;
            return false;
        }
    }
    
    function restartBot() {
        log('Перезапуск бота...', 'WARN');
        jobs = 0; // Сбрасываем счетчик заданий
        
        // Глобальный флаг для отслеживания процесса перезапуска
        if (global.isRestarting) {
            log('Перезапуск уже выполняется, пропускаем...', 'WARN');
            return;
        }
        
        global.isRestarting = true;
        
        // Пересоздаем дашборд если режим DISABLE_DASHBOARD выключен
        if (!DISABLE_DASHBOARD) {
            // Принудительно уничтожаем dashboard
            forceDestroyScreen();
            
            // Запускаем с задержкой для корректного уничтожения
            setTimeout(() => {
                setupDashboard();
                
                // Запускаем основную функцию с дополнительной задержкой
                setTimeout(() => {
                    global.isRestarting = false;
                    main();
                }, 2000);
            }, 3000);
        } else {
            // Если Dashboard отключен, просто запускаем main
            setTimeout(() => {
                global.isRestarting = false;
                main();
            }, 1000);
        }
    }
    
    // Инициализация и запуск
    if (!DISABLE_DASHBOARD) {
        setupDashboard();
    }
    
    // Запуск основной функции
    main();
    
    // Добавляем периодическую проверку статуса, если используется Dashboard
    if (!DISABLE_DASHBOARD) {
        setInterval(() => {
            if (!dashboardActive) {
                log('Dashboard не активен, попытка восстановления...', 'WARN');
                setupDashboard();
            }
        }, 60000); // Проверка каждую минуту
    }

    // Обновляем функцию checkHeartbeat
    function checkHeartbeat() {
        const now = Date.now();
        const minutesSinceLastHeartbeat = (now - global.lastHeartbeat) / (1000 * 60);
        
        if (minutesSinceLastHeartbeat > 10) { // Если нет активности более 10 минут
            log(`[КРИТИЧЕСКАЯ ОШИБКА] Бот не отвечает уже ${Math.round(minutesSinceLastHeartbeat)} минут!`, 'ERROR');
            // Записываем ошибку в файл
            try {
                const errorLogPath = path.join(__dirname, 'error.log');
                const errorMessage = `[${new Date().toISOString()}] Бот не отвечает уже ${Math.round(minutesSinceLastHeartbeat)} минут! Перезапуск...\n\n`;
                fs.appendFileSync(errorLogPath, errorMessage);
            } catch (e) {
                console.error('Не удалось записать лог ошибки:', e);
            }
            
            // Перезапускаем бота
            restartBot();
        } else {
            // Если всё в порядке, также обновляем heartbeat
            global.updateHeartbeat();
        }
    }
    
    // Проверяем "сердцебиение" каждые 5 минут
    setInterval(checkHeartbeat, 5 * 60 * 1000);
}
