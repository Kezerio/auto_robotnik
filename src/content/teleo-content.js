/**
 * Content script для Teleo (teleo.telphin.ru).
 * Проверяет наличие страницы логина, парсит базовые данные.
 */

(function () {
  'use strict';

  function isLoginPage() {
    const loginForms = document.querySelectorAll(
      'form[action*="login"], input[type="password"], .login-form'
    );
    return loginForms.length > 0;
  }

  function getCurrentSection() {
    const path = window.location.pathname;
    if (path.includes('/staff/')) return 'staff';
    if (path.includes('/routing')) return 'routing';
    if (path.includes('/extension')) return 'extensions';
    return 'main';
  }

  function collectData() {
    return {
      source: 'teleo',
      url: window.location.href,
      section: getCurrentSection(),
      isLoginPage: isLoginPage(),
      title: document.title
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PARSE_TELEO') {
      sendResponse({ ok: true, data: collectData() });
      return true;
    }
    if (msg.type === 'CHECK_LOGIN') {
      sendResponse({ ok: true, isLoginPage: isLoginPage() });
      return true;
    }
  });

  // Если это страница логина — уведомить пользователя
  setTimeout(() => {
    const data = collectData();
    if (data.isLoginPage) {
      chrome.runtime.sendMessage({
        type: 'LOGIN_REQUIRED',
        data: { system: 'teleo', url: window.location.href }
      });
    } else {
      chrome.runtime.sendMessage({ type: 'TELEO_DATA_READY', data });
    }
  }, 1000);
})();
