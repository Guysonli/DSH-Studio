'use strict';
// loading 页：显示启动阶段与版本信息；收到致命错误跳转错误页
window.dshDesktop.getVersionInfo().then((v) => {
  document.getElementById('version').textContent = 'dsh ' + v.dshVersion + ' · 应用 ' + v.appVersion;
}).catch(() => {});
window.dshDesktop.onStage(({ stage, detail }) => {
  document.getElementById('stage').textContent = detail || stage;
});
window.dshDesktop.onFatal(({ message, detail }) => {
  location.href = 'error.html?m=' + encodeURIComponent(message) + '&d=' + encodeURIComponent(detail || '');
});
