/**
 * Предустановленные сценарии (playbooks).
 */

/**
 * Сценарий: Подключение АТС
 */
export const SCENARIO_ATC_CONNECT = {
  id: 'builtin_atc_connect',
  name: 'Подключение АТС',
  builtIn: true,
  steps: [
    {
      id: 'parse_otrs',
      type: 'auto',
      description: 'Извлечь данные из тикета OTRS',
      system: 'OTRS',
      action: 'parse',
      params: {
        parseMessage: 'PARSE_OTRS',
        urlPattern: 'otrs.tlpn'
      },
      waitForConfirm: false
    },
    {
      id: 'open_accounting',
      type: 'step',
      description: 'Открыть Accounting по коду клиента',
      system: 'Accounting',
      action: 'navigate',
      params: {
        url: 'http://intra10.office.tlpn/admin/customer_show.php?otrs_customer={clientCode}',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'parse_accounting',
      type: 'auto',
      description: 'Извлечь номер линии и услуги из Accounting',
      system: 'Accounting',
      action: 'parse',
      params: {
        parseMessage: 'PARSE_ACCOUNTING',
        urlPattern: 'intra10.office.tlpn/admin'
      },
      waitForConfirm: false
    },
    {
      id: 'show_services',
      type: 'checkpoint',
      description: 'Проверить данные: номер линии и список услуг',
      system: 'Accounting',
      action: 'extract',
      params: {
        parseMessage: 'PARSE_ACCOUNTING',
        urlPattern: 'intra10.office.tlpn/admin'
      },
      waitForConfirm: true
    },
    {
      id: 'open_support_script',
      type: 'step',
      description: 'Открыть Support Script (АТС Teleo)',
      system: 'Support Script',
      action: 'navigate',
      params: {
        url: 'http://intra10.office.tlpn/support/support_script/index.php?id=atc_teleo',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'fill_line_number',
      type: 'step',
      description: 'Вставить номер линии в Support Script',
      system: 'Support Script',
      action: 'fill',
      params: {
        fillMessage: 'SUPPORT_SET_LINE',
        urlPattern: 'intra10.office.tlpn/support',
        value: '{lineNumber}'
      },
      waitForConfirm: true
    },
    {
      id: 'click_create_atc',
      type: 'step',
      description: 'Нажать "Создать АТС"',
      system: 'Support Script',
      action: 'click',
      params: {
        clickMessage: 'SUPPORT_CLICK_CREATE_ATC',
        urlPattern: 'intra10.office.tlpn/support'
      },
      waitForConfirm: true
    },
    {
      id: 'open_ringme',
      type: 'step',
      description: 'Открыть Ringme — поиск по коду клиента',
      system: 'Ringme',
      action: 'navigate',
      params: {
        url: 'https://ringmeadmin.tlpn/clients/?q={clientCode}',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'parse_ringme',
      type: 'auto',
      description: 'Найти ссылку на Teleo в Ringme',
      system: 'Ringme',
      action: 'parse',
      params: {
        parseMessage: 'PARSE_RINGME',
        urlPattern: 'ringmeadmin.tlpn'
      },
      waitForConfirm: false
    },
    {
      id: 'open_teleo_staff',
      type: 'step',
      description: 'Открыть Teleo — раздел Сотрудники',
      system: 'Teleo',
      action: 'navigate',
      params: {
        url: 'https://teleo.telphin.ru/staff/',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'open_teleo_routing',
      type: 'step',
      description: 'Открыть Teleo — раздел Маршрутизация',
      system: 'Teleo',
      action: 'navigate',
      params: {
        url: 'https://teleo.telphin.ru/routing_new/',
        activate: true
      },
      waitForConfirm: true
    }
  ]
};

/**
 * Сценарий: Отложить на 14 дней
 */
export const SCENARIO_POSTPONE_14 = {
  id: 'builtin_postpone_14',
  name: 'Отложить на 14 дней',
  builtIn: true,
  steps: [
    {
      id: 'parse_ticket',
      type: 'auto',
      description: 'Извлечь TicketID из текущего тикета',
      system: 'OTRS',
      action: 'parse',
      params: {
        parseMessage: 'PARSE_OTRS',
        urlPattern: 'otrs.tlpn'
      },
      waitForConfirm: false
    },
    {
      id: 'move_queue',
      type: 'step',
      description: 'Переместить тикет в очередь 14day',
      system: 'OTRS',
      action: 'click',
      params: {
        clickMessage: 'OTRS_MOVE_QUEUE',
        urlPattern: 'otrs.tlpn',
        extra: { queue: '14day' }
      },
      waitForConfirm: true
    },
    {
      id: 'open_freetext',
      type: 'step',
      description: 'Открыть форму "Свободные поля" (AgentTicketFreeText)',
      system: 'OTRS',
      action: 'navigate',
      params: {
        url: 'http://otrs.tlpn/otrs/index.pl?Action=AgentTicketFreeText;TicketID={ticketId}',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'set_pending_state',
      type: 'step',
      description: 'Установить состояние "ожидает напоминания" и дату +14 дней',
      system: 'OTRS',
      action: 'custom',
      params: {
        instruction: 'Выставить: Следующее состояние = "ожидает напоминания", Дата = сегодня + 14 дней. Нажать "Отправить".'
      },
      waitForConfirm: true
    }
  ]
};

/**
 * Сценарий: Runexis — подобрать номера
 * Запускается из консоли с вводом: город, тип номеров, код (для Москвы).
 * Этот сценарий управляется из UI (runexisWizard), а не через обычный PlaybookEngine,
 * так как требует ввода пользователя и многошаговой логики (2 прохода для Москвы).
 */
export const SCENARIO_RUNEXIS_NUMBERS = {
  id: 'builtin_runexis_numbers',
  name: 'Runexis — подобрать номера',
  builtIn: true,
  requiresInput: true,
  inputType: 'runexis',
  steps: [
    {
      id: 'open_login',
      type: 'step',
      description: 'Открыть Runexis (логин)',
      system: 'Runexis',
      action: 'navigate',
      params: {
        url: 'https://did-trunk.runexis.ru/site/login',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'check_auth',
      type: 'auto',
      description: 'Проверить авторизацию',
      system: 'Runexis',
      action: 'custom',
      params: {
        instruction: 'Если страница логина — дождаться автозаполнения, нажать "Войти". Если требуется ручной вход — пауза.'
      },
      waitForConfirm: false
    },
    {
      id: 'open_numbers',
      type: 'step',
      description: 'Открыть страницу номеров',
      system: 'Runexis',
      action: 'navigate',
      params: {
        url: 'https://did-trunk.runexis.ru/numbers',
        activate: true
      },
      waitForConfirm: true
    },
    {
      id: 'set_filters',
      type: 'auto',
      description: 'Заполнить фильтры (город, тип, код)',
      system: 'Runexis',
      action: 'custom',
      params: {
        instruction: 'Заполнить поля: Город, Тип = Простой, Код (если Москва).'
      },
      waitForConfirm: false
    },
    {
      id: 'apply_filters',
      type: 'step',
      description: 'Нажать "Применить"',
      system: 'Runexis',
      action: 'custom',
      params: {
        instruction: 'Нажать кнопку "Применить" для поиска номеров.'
      },
      waitForConfirm: true
    },
    {
      id: 'navigate_page',
      type: 'auto',
      description: 'Перейти на нужную страницу (3, 2 или 1)',
      system: 'Runexis',
      action: 'custom',
      params: {
        instruction: 'Перейти на страницу 3 (если есть), иначе 2, иначе 1.'
      },
      waitForConfirm: false
    },
    {
      id: 'collect_numbers',
      type: 'auto',
      description: 'Собрать номера со страницы',
      system: 'Runexis',
      action: 'custom',
      params: {
        instruction: 'Извлечь все номера, нормализовать до 11 цифр (7 спереди), сформировать список.'
      },
      waitForConfirm: false
    },
    {
      id: 'copy_result',
      type: 'checkpoint',
      description: 'Скопировать результат в буфер + показать кнопку "Вставить в OTRS"',
      system: 'Runexis',
      action: 'custom',
      params: {
        instruction: 'Результат скопирован в буфер. Нажмите "Вставить в OTRS" для вставки в окно ответа/заметки.'
      },
      waitForConfirm: true
    }
  ]
};

export const BUILTIN_SCENARIOS = [
  SCENARIO_ATC_CONNECT,
  SCENARIO_POSTPONE_14,
  SCENARIO_RUNEXIS_NUMBERS
];
