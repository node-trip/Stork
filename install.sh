#!/bin/bash

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Функция для вывода сообщений
print_message() {
  echo -e "${BLUE}[STORK INSTALLER]${NC} $1"
}

print_success() {
  echo -e "${GREEN}[УСПЕХ]${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}[ВНИМАНИЕ]${NC} $1"
}

print_error() {
  echo -e "${RED}[ОШИБКА]${NC} $1"
}

# Проверка прав суперпользователя
check_root() {
  if [[ $EUID -ne 0 ]]; then
    print_warning "Этот скрипт рекомендуется запускать с правами суперпользователя"
    print_warning "Некоторые операции могут не выполниться без прав суперпользователя"
    
    # Спрашиваем, продолжать ли
    read -p "Продолжить установку без прав суперпользователя? (да/нет): " choice
    case "$choice" in 
      да|д|y|yes ) 
        print_message "Продолжаем установку..."
        ;;
      * ) 
        print_message "Перезапустите скрипт с sudo: sudo ./install.sh"
        exit 1
        ;;
    esac
  else
    print_success "Запущено с правами суперпользователя"
  fi
}

# Определение дистрибутива Linux
detect_distro() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VERSION=$VERSION_ID
    print_message "Обнаружена операционная система: $OS $VERSION"
  elif type lsb_release >/dev/null 2>&1; then
    OS=$(lsb_release -si)
    VERSION=$(lsb_release -sr)
    print_message "Обнаружена операционная система: $OS $VERSION"
  else
    print_error "Не удалось определить дистрибутив"
    OS="Unknown"
  fi
}

# Установка пакетов в зависимости от дистрибутива
install_package() {
  package_name=$1
  print_message "Проверка наличия $package_name..."
  
  if command -v $package_name >/dev/null 2>&1; then
    print_success "$package_name уже установлен"
    return 0
  fi
  
  print_message "Установка $package_name..."
  
  case $OS in
    *"Ubuntu"*|*"Debian"*)
      apt-get update -qq
      apt-get install -y $package_name > /dev/null 2>&1
      ;;
    *"CentOS"*|*"Red Hat"*|*"Fedora"*)
      yum install -y $package_name > /dev/null 2>&1
      ;;
    *"SUSE"*)
      zypper install -y $package_name > /dev/null 2>&1
      ;;
    *)
      print_error "Не удалось определить подходящий менеджер пакетов для $OS"
      print_error "Пожалуйста, установите $package_name вручную"
      return 1
      ;;
  esac
  
  if [ $? -eq 0 ]; then
    print_success "$package_name успешно установлен"
    return 0
  else
    print_error "Не удалось установить $package_name"
    return 1
  fi
}

# Установка Node.js
install_nodejs() {
  if command -v node >/dev/null 2>&1; then
    node_version=$(node -v)
    print_success "Node.js $node_version уже установлен"
    
    # Проверяем версию Node.js (нам нужна версия 14 или выше)
    version_number=$(echo $node_version | cut -d 'v' -f 2 | cut -d '.' -f 1)
    if [ "$version_number" -lt 14 ]; then
      print_warning "У вас установлена устаревшая версия Node.js: $node_version"
      print_message "Для работы Stork Bot требуется Node.js 14 или выше"
      
      read -p "Обновить Node.js? (да/нет): " choice
      case "$choice" in 
        да|д|y|yes )
          # Удаляем старую версию
          print_message "Удаление старой версии Node.js..."
          case $OS in
            *"Ubuntu"*|*"Debian"*)
              apt-get remove -y nodejs npm > /dev/null 2>&1
              ;;
            *"CentOS"*|*"Red Hat"*|*"Fedora"*)
              yum remove -y nodejs npm > /dev/null 2>&1
              ;;
            *"SUSE"*)
              zypper remove -y nodejs npm > /dev/null 2>&1
              ;;
          esac
          
          # Устанавливаем новую версию
          install_nodejs_latest
          ;;
        * )
          print_warning "Продолжение с текущей версией Node.js. Это может привести к проблемам."
          ;;
      esac
    fi
    
    return 0
  else
    install_nodejs_latest
    return $?
  fi
}

# Установка последней версии Node.js
install_nodejs_latest() {
  print_message "Установка Node.js..."
  
  # Устанавливаем curl, если его нет
  install_package curl
  
  case $OS in
    *"Ubuntu"*|*"Debian"*)
      curl -fsSL https://deb.nodesource.com/setup_18.x | bash - > /dev/null 2>&1
      apt-get install -y nodejs > /dev/null 2>&1
      ;;
    *"CentOS"*|*"Red Hat"*|*"Fedora"*)
      curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - > /dev/null 2>&1
      yum install -y nodejs > /dev/null 2>&1
      ;;
    *)
      print_error "Автоматическая установка Node.js не поддерживается для $OS"
      print_error "Пожалуйста, установите Node.js 14+ вручную: https://nodejs.org/en/download/"
      return 1
      ;;
  esac
  
  if command -v node >/dev/null 2>&1; then
    node_version=$(node -v)
    print_success "Node.js $node_version успешно установлен"
    return 0
  else
    print_error "Не удалось установить Node.js"
    return 1
  fi
}

# Установка Git
install_git() {
  if command -v git >/dev/null 2>&1; then
    git_version=$(git --version)
    print_success "$git_version уже установлен"
    return 0
  else
    install_package git
    return $?
  fi
}

# Установка утилиты screen
install_screen() {
  if command -v screen >/dev/null 2>&1; then
    print_success "Screen уже установлен"
    return 0
  else
    install_package screen
    return $?
  fi
}

# Клонирование репозитория Stork
clone_repository() {
  if [ -d "Stork" ]; then
    print_warning "Директория Stork уже существует"
    
    read -p "Обновить существующую установку? (да/нет): " choice
    case "$choice" in 
      да|д|y|yes )
        print_message "Обновление репозитория..."
        cd Stork
        git pull
        if [ $? -eq 0 ]; then
          print_success "Репозиторий успешно обновлен"
        else
          print_error "Не удалось обновить репозиторий"
          return 1
        fi
        ;;
      * )
        print_message "Пропускаем обновление репозитория"
        cd Stork
        ;;
    esac
  else
    print_message "Клонирование репозитория Stork..."
    git clone https://github.com/node-trip/Stork.git
    if [ $? -eq 0 ]; then
      print_success "Репозиторий успешно клонирован"
      cd Stork
    else
      print_error "Не удалось клонировать репозиторий"
      return 1
    fi
  fi
  
  return 0
}

# Установка зависимостей npm
install_dependencies() {
  print_message "Установка зависимостей..."
  npm install
  
  if [ $? -eq 0 ]; then
    print_success "Зависимости успешно установлены"
    return 0
  else
    print_error "Не удалось установить зависимости"
    return 1
  fi
}

# Настройка systemd сервиса для автозапуска
setup_systemd_service() {
  if [ ! -d "/etc/systemd/system" ]; then
    print_warning "Systemd не найден, пропускаем настройку автозапуска"
    return 1
  fi
  
  print_message "Настройка автозапуска через systemd..."
  
  # Получаем текущий рабочий каталог
  current_dir=$(pwd)
  
  # Создаем файл службы
  cat > /tmp/stork.service <<EOL
[Unit]
Description=Stork Network Automation Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$current_dir
ExecStart=$(which node) $current_dir/index.js --run
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=stork-bot

[Install]
WantedBy=multi-user.target
EOL
  
  # Копируем файл службы
  if [ $EUID -eq 0 ]; then
    cp /tmp/stork.service /etc/systemd/system/stork.service
    systemctl daemon-reload
    print_success "Служба systemd успешно создана"
    
    read -p "Включить автозапуск Stork Bot при загрузке системы? (да/нет): " choice
    case "$choice" in 
      да|д|y|yes )
        systemctl enable stork.service
        print_success "Автозапуск включен"
        ;;
      * )
        print_message "Автозапуск не включен"
        ;;
    esac
    
    print_message "Для управления службой используйте команды:"
    echo "  sudo systemctl start stork   - Запуск бота"
    echo "  sudo systemctl stop stork    - Остановка бота"
    echo "  sudo systemctl status stork  - Проверка статуса"
    echo "  sudo systemctl enable stork  - Включение автозапуска"
    echo "  sudo systemctl disable stork - Отключение автозапуска"
  else
    print_warning "Для настройки службы systemd требуются права суперпользователя"
    print_message "Вы можете настроить службу вручную с помощью следующего файла:"
    echo "/tmp/stork.service"
  fi
}

# Главная функция установки
main() {
  clear
  echo -e "${BLUE}"
  echo "  ███████╗████████╗ ██████╗ ██████╗ ██╗  ██╗    ██████╗  ██████╗ ████████╗"
  echo "  ██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗██║ ██╔╝    ██╔══██╗██╔═══██╗╚══██╔══╝"
  echo "  ███████╗   ██║   ██║   ██║██████╔╝█████╔╝     ██████╔╝██║   ██║   ██║   "
  echo "  ╚════██║   ██║   ██║   ██║██╔══██╗██╔═██╗     ██╔══██╗██║   ██║   ██║   "
  echo "  ███████║   ██║   ╚██████╔╝██║  ██║██║  ██╗    ██████╔╝╚██████╔╝   ██║   "
  echo "  ╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝    ╚═════╝  ╚═════╝    ╚═╝   "
  echo -e "${NC}"                                                                         
  echo "                        Установщик Stork Bot                       "
  echo "                         Версия установщика: 1.0                    "
  echo "---------------------------------------------------------------------"
  
  # Проверяем наличие прав суперпользователя
  check_root
  
  # Определяем дистрибутив Linux
  detect_distro
  
  # Устанавливаем зависимости
  install_git || exit 1
  install_nodejs || exit 1
  install_screen || print_warning "Не удалось установить screen, но установка продолжится"
  
  # Клонируем репозиторий
  clone_repository || exit 1
  
  # Устанавливаем npm-зависимости
  install_dependencies || exit 1
  
  # Настраиваем автозапуск
  setup_systemd_service
  
  # Предлагаем настроить бота
  print_message "Установка завершена! Теперь вы можете настроить бота"
  
  read -p "Запустить мастер настройки? (да/нет): " choice
  case "$choice" in 
    да|д|y|yes )
      print_message "Запуск мастера настройки..."
      print_message "Вам будет предложено настроить аккаунты, прокси и другие параметры."
      
      read -p "Использовать быструю настройку? (да/нет): " quick_setup
      case "$quick_setup" in 
        да|д|y|yes )
          npm run quicksetup
          ;;
        * )
          npm run setup
          ;;
      esac
      
      print_success "Настройка завершена!"
      ;;
    * )
      print_message "Вы можете настроить бота позже с помощью команд:"
      echo "  npm run quicksetup - Быстрая настройка"
      echo "  npm run setup      - Расширенная настройка"
      ;;
  esac
  
  # Предлагаем запустить бота
  read -p "Запустить Stork Bot сейчас? (да/нет): " choice
  case "$choice" in 
    да|д|y|yes )
      if [ $EUID -eq 0 ] && [ -f "/etc/systemd/system/stork.service" ]; then
        print_message "Запуск бота через systemd..."
        systemctl start stork
        sleep 2
        systemctl status stork
      else
        print_message "Запуск бота..."
        if command -v screen >/dev/null 2>&1; then
          print_message "Запуск в screen-сессии 'stork'..."
          screen -dmS stork npm start
          print_success "Бот запущен в screen-сессии"
          print_message "Для подключения к сессии используйте команду: screen -r stork"
        else
          print_warning "Screen не установлен, запуск в обычном режиме"
          print_warning "Бот остановится при закрытии терминала!"
          npm start
        fi
      fi
      ;;
    * )
      print_message "Вы можете запустить бота позже с помощью команды:"
      if [ $EUID -eq 0 ] && [ -f "/etc/systemd/system/stork.service" ]; then
        echo "  sudo systemctl start stork"
      else
        echo "  npm start"
        if command -v screen >/dev/null 2>&1; then
          echo "  или используйте screen: screen -dmS stork npm start"
        fi
      fi
      ;;
  esac
  
  print_success "Установка и настройка Stork Bot завершена!"
}

# Запускаем установку
main 