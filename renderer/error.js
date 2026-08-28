'use strict';
// error 页：显示失败信息并支持重试
const q = new URLSearchParams(location.search);
document.getElementById('msg').textContent = q.get('m') || '未知错误';
document.getElementById('detail').textContent = q.get('d') || '';
document.getElementById('retry').onclick = () => window.dshDesktop.retry();
