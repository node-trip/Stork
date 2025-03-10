import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { getBannerText } from './banner.js';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Создаем интерфейс readline
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Функция для асинхронного запроса данных у пользователя
function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Функция для проверки существования файла
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (err) {
    return false;
  }
}

// Функция для загрузки существующего конфига
function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (fileExists(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    }
  } catch (err) {
    console.error('Ошибка при чтении файла конфигурации:', err);
  }
  
  // Возвращаем значения по умолчанию
  return {
    cognito: {
      region: "ap-northeast-1",
      clientId: "5msns4n49hmg3dftp2tp1t2iuh",
      userPoolId: "ap-northeast-1_M22I44OpC"
    },
    stork: {
      intervalSeconds: 60
    },
    threads: {
      maxWorkers: 10
    }
  };
}

// Функция для сохранения конфига
function saveConfig(config) {
  try {
    const configPath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(chalk.green('✓ Конфигурация успешно сохранена'));
  } catch (err) {
    console.error('Ошибка при сохранении конфигурации:', err);
  }
}

// Функция для управления аккаунтами
async function manageAccounts() {
  const accountsPath = path.join(__dirname, 'accounts.txt');
  let accounts = [];
  
  // Загружаем существующие аккаунты, если файл существует
  if (fileExists(accountsPath)) {
    const accountsData = fs.readFileSync(accountsPath, 'utf8');
    accounts = accountsData.split('\n').filter(account => account.trim() !== '');
  }
  
  console.log(chalk.yellow(`\nУправление аккаунтами. Найдено аккаунтов: ${accounts.length}`));
  
  while (true) {
    console.log('\n1. Добавить аккаунт');
    console.log('2. Просмотреть аккаунты');
    console.log('3. Удалить аккаунт');
    console.log('4. Очистить все аккаунты');
    console.log('5. Вернуться в главное меню');
    
    const choice = await question('Выберите действие (1-5): ');
    
    switch (choice) {
      case '1':
        const email = await question('Введите email: ');
        const password = await question('Введите пароль: ');
        accounts.push(`${email}|${password}`);
        fs.writeFileSync(accountsPath, accounts.join('\n'), 'utf8');
        console.log(chalk.green('✓ Аккаунт добавлен'));
        break;
      
      case '2':
        if (accounts.length === 0) {
          console.log(chalk.yellow('Список аккаунтов пуст'));
        } else {
          console.log(chalk.yellow('\nСписок аккаунтов:'));
          accounts.forEach((account, index) => {
            const [email, _] = account.split('|');
            console.log(`${index + 1}. ${email}`);
          });
        }
        break;
      
      case '3':
        if (accounts.length === 0) {
          console.log(chalk.yellow('Список аккаунтов пуст'));
        } else {
          console.log(chalk.yellow('\nСписок аккаунтов:'));
          accounts.forEach((account, index) => {
            const [email, _] = account.split('|');
            console.log(`${index + 1}. ${email}`);
          });
          
          const indexToRemove = await question('Введите номер аккаунта для удаления: ');
          const idx = parseInt(indexToRemove) - 1;
          
          if (idx >= 0 && idx < accounts.length) {
            accounts.splice(idx, 1);
            fs.writeFileSync(accountsPath, accounts.join('\n'), 'utf8');
            console.log(chalk.green('✓ Аккаунт удален'));
          } else {
            console.log(chalk.red('✗ Неверный номер аккаунта'));
          }
        }
        break;
      
      case '4':
        const confirm = await question('Вы уверены, что хотите удалить все аккаунты? (да/нет): ');
        if (confirm.toLowerCase() === 'да') {
          accounts = [];
          fs.writeFileSync(accountsPath, '', 'utf8');
          console.log(chalk.green('✓ Все аккаунты удалены'));
        }
        break;
      
      case '5':
        return;
      
      default:
        console.log(chalk.red('✗ Неверный выбор. Пожалуйста, выберите 1-5'));
    }
  }
}

// Функция для управления прокси
async function manageProxies() {
  const proxiesPath = path.join(__dirname, 'proxies.txt');
  let proxies = [];
  
  // Загружаем существующие прокси, если файл существует
  if (fileExists(proxiesPath)) {
    const proxiesData = fs.readFileSync(proxiesPath, 'utf8');
    proxies = proxiesData.split('\n').filter(proxy => proxy.trim() !== '');
  }
  
  console.log(chalk.yellow(`\nУправление прокси. Найдено прокси: ${proxies.length}`));
  
  while (true) {
    console.log('\n1. Добавить HTTP/HTTPS прокси');
    console.log('2. Добавить SOCKS прокси');
    console.log('3. Просмотреть прокси');
    console.log('4. Удалить прокси');
    console.log('5. Очистить все прокси');
    console.log('6. Вернуться в главное меню');
    
    const choice = await question('Выберите действие (1-6): ');
    
    switch (choice) {
      case '1':
        const httpProxy = await question('Введите HTTP/HTTPS прокси (формат: http://user:pass@ip:port): ');
        if (httpProxy.startsWith('http://') || httpProxy.startsWith('https://')) {
          proxies.push(httpProxy);
          fs.writeFileSync(proxiesPath, proxies.join('\n'), 'utf8');
          console.log(chalk.green('✓ HTTP/HTTPS прокси добавлен'));
        } else {
          console.log(chalk.red('✗ Неверный формат. Прокси должен начинаться с http:// или https://'));
        }
        break;
      
      case '2':
        const socksProxy = await question('Введите SOCKS прокси (формат: socks://user:pass@ip:port или socks5://user:pass@ip:port): ');
        if (socksProxy.startsWith('socks://') || socksProxy.startsWith('socks5://')) {
          proxies.push(socksProxy);
          fs.writeFileSync(proxiesPath, proxies.join('\n'), 'utf8');
          console.log(chalk.green('✓ SOCKS прокси добавлен'));
        } else {
          console.log(chalk.red('✗ Неверный формат. Прокси должен начинаться с socks:// или socks5://'));
        }
        break;
      
      case '3':
        if (proxies.length === 0) {
          console.log(chalk.yellow('Список прокси пуст'));
        } else {
          console.log(chalk.yellow('\nСписок прокси:'));
          proxies.forEach((proxy, index) => {
            console.log(`${index + 1}. ${proxy}`);
          });
        }
        break;
      
      case '4':
        if (proxies.length === 0) {
          console.log(chalk.yellow('Список прокси пуст'));
        } else {
          console.log(chalk.yellow('\nСписок прокси:'));
          proxies.forEach((proxy, index) => {
            console.log(`${index + 1}. ${proxy}`);
          });
          
          const indexToRemove = await question('Введите номер прокси для удаления: ');
          const idx = parseInt(indexToRemove) - 1;
          
          if (idx >= 0 && idx < proxies.length) {
            proxies.splice(idx, 1);
            fs.writeFileSync(proxiesPath, proxies.join('\n'), 'utf8');
            console.log(chalk.green('✓ Прокси удален'));
          } else {
            console.log(chalk.red('✗ Неверный номер прокси'));
          }
        }
        break;
      
      case '5':
        const confirm = await question('Вы уверены, что хотите удалить все прокси? (да/нет): ');
        if (confirm.toLowerCase() === 'да') {
          proxies = [];
          fs.writeFileSync(proxiesPath, '', 'utf8');
          console.log(chalk.green('✓ Все прокси удалены'));
        }
        break;
      
      case '6':
        return;
      
      default:
        console.log(chalk.red('✗ Неверный выбор. Пожалуйста, выберите 1-6'));
    }
  }
}

// Функция для настройки параметров конфигурации
async function configureSettings() {
  const config = loadConfig();
  
  console.log(chalk.yellow('\nНастройка параметров'));
  
  // Настройка интервала
  const intervalStr = await question(`Введите интервал в секундах между валидациями [${config.stork.intervalSeconds}]: `);
  if (intervalStr.trim() !== '') {
    const interval = parseInt(intervalStr);
    if (!isNaN(interval) && interval > 0) {
      config.stork.intervalSeconds = interval;
    } else {
      console.log(chalk.red('✗ Неверное значение. Используется значение по умолчанию.'));
    }
  }
  
  // Настройка максимального количества рабочих потоков
  const workersStr = await question(`Введите максимальное количество потоков [${config.threads.maxWorkers}]: `);
  if (workersStr.trim() !== '') {
    const workers = parseInt(workersStr);
    if (!isNaN(workers) && workers > 0) {
      config.threads.maxWorkers = workers;
    } else {
      console.log(chalk.red('✗ Неверное значение. Используется значение по умолчанию.'));
    }
  }
  
  // Настройка параметров Cognito
  console.log(chalk.yellow('\nНастройка параметров Cognito (опционально)'));
  console.log(chalk.gray('Оставьте поля пустыми, чтобы использовать значения по умолчанию'));
  
  const region = await question(`Введите регион [${config.cognito.region}]: `);
  if (region.trim() !== '') {
    config.cognito.region = region;
  }
  
  const clientId = await question(`Введите Client ID [${config.cognito.clientId}]: `);
  if (clientId.trim() !== '') {
    config.cognito.clientId = clientId;
  }
  
  const userPoolId = await question(`Введите User Pool ID [${config.cognito.userPoolId}]: `);
  if (userPoolId.trim() !== '') {
    config.cognito.userPoolId = userPoolId;
  }
  
  // Сохраняем конфигурацию
  saveConfig(config);
}

// Основная функция настройки
async function setup() {
  console.log(chalk.blue(getBannerText()));
  console.log(chalk.green('Мастер настройки Stork Bot'));
  
  while (true) {
    console.log('\n1. Управление аккаунтами');
    console.log('2. Управление прокси');
    console.log('3. Настройка параметров');
    console.log('4. Запуск бота');
    console.log('5. Выход');
    
    const choice = await question('Выберите действие (1-5): ');
    
    switch (choice) {
      case '1':
        await manageAccounts();
        break;
      
      case '2':
        await manageProxies();
        break;
      
      case '3':
        await configureSettings();
        break;
      
      case '4':
        console.log(chalk.green('Запуск бота...'));
        rl.close();
        // Используем динамический импорт для запуска main.js
        import('./main.js').catch(err => {
          console.error('Ошибка при запуске бота:', err);
          process.exit(1);
        });
        return;
      
      case '5':
        console.log(chalk.green('Выход из программы...'));
        rl.close();
        process.exit(0);
        break;
      
      default:
        console.log(chalk.red('✗ Неверный выбор. Пожалуйста, выберите 1-5'));
    }
  }
}

// Запускаем настройку
setup().catch(err => {
  console.error('Произошла ошибка:', err);
  rl.close();
  process.exit(1);
}); 