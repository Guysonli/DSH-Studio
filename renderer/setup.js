'use strict';
// setup 页：首次配置 API Key
const input = document.getElementById('key');
const btn = document.getElementById('save');
const err = document.getElementById('err');

btn.onclick = async () => {
  const key = input.value.trim();
  if (!key) { err.textContent = '请输入 API Key'; return; }
  err.textContent = '';
  try {
    await window.dshDesktop.submitApiKey(key);
    location.href = 'loading.html';
  } catch (e) {
    err.textContent = '保存失败：' + e.message;
  }
};
input.onkeydown = (e) => { if (e.key === 'Enter') btn.onclick(); };
