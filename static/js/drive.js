/* Drive page interactions: view switch, dialogs, upload, rename, delete. */
(function () {
  'use strict';

  const MC = window.MC;
  const CONFIG = window.MCCLOUD_DRIVE || { folderId: null, isAdmin: false };
  if (!MC) return;

  /* ------------------------------------------------------------- view mode */
  const grid = document.getElementById('itemsGrid');
  const viewButtons = Array.from(document.querySelectorAll('[data-view]'));

  function applyView(view, persist) {
    if (!grid) return;
    grid.classList.toggle('list-view', view === 'list');
    viewButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
    if (persist) {
      try { localStorage.setItem('mccloud-view', view); } catch (e) { /* ignore */ }
    }
  }

  if (grid) {
    let saved = null;
    try { saved = localStorage.getItem('mccloud-view'); } catch (e) { /* ignore */ }
    if (saved === 'grid' || saved === 'list') applyView(saved, false);
    viewButtons.forEach((btn) => {
      btn.addEventListener('click', () => applyView(btn.dataset.view, true));
    });
  }

  /* --------------------------------------------------------------- helpers */
  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = (label || '处理中…');
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  function showFieldError(id, message) {
    const box = document.getElementById(id);
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('show', Boolean(message));
  }

  function handleApiError(err, errorBoxId) {
    if (err && err.status === 401) {
      MC.snack('管理员登录已过期，请重新登录。', 'error');
      setTimeout(() => { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); }, 1200);
      return;
    }
    if (errorBoxId) showFieldError(errorBoxId, err.message);
    else MC.snack(err.message || '操作失败。', 'error');
  }

  if (!CONFIG.isAdmin) {
    wireBrowseShortcuts();
    return;
  }

  /* --------------------------------------------------------------- folders */
  const folderForm = document.getElementById('folderForm');
  const folderSubmit = document.getElementById('folderSubmit');
  const folderDialog = document.getElementById('folderDialog');

  if (folderForm) {
    folderForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('folderName');
      const name = input.value.trim();
      if (!name) { showFieldError('folderError', '请输入文件夹名称。'); input.focus(); return; }
      showFieldError('folderError', '');
      setBusy(folderSubmit, true, '创建中…');
      try {
        await MC.api('/api/folders', { method: 'POST', json: { name: name, parent_id: CONFIG.folderId } });
        folderDialog.close();
        MC.snack('文件夹已创建', 'success');
        setTimeout(() => location.reload(), 350);
      } catch (err) {
        handleApiError(err, 'folderError');
      } finally {
        setBusy(folderSubmit, false);
      }
    });
  }

  document.querySelectorAll('[data-dialog-open="folderDialog"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (folderForm) folderForm.reset();
      showFieldError('folderError', '');
    });
  });

  /* --------------------------------------------------------------- rename */
  const renameDialog = document.getElementById('renameDialog');
  const renameForm = document.getElementById('renameForm');
  const renameSubmit = document.getElementById('renameSubmit');

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="rename"]');
    if (!target) return;
    document.getElementById('renameType').value = target.dataset.itemType;
    document.getElementById('renameId').value = target.dataset.itemId;
    document.getElementById('renameName').value = target.dataset.itemName || '';
    showFieldError('renameError', '');
    MC.openDialog(renameDialog);
  });

  if (renameForm) {
    renameForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const type = document.getElementById('renameType').value;
      const id = document.getElementById('renameId').value;
      const name = document.getElementById('renameName').value.trim();
      if (!name) { showFieldError('renameError', '请输入新名称。'); return; }
      setBusy(renameSubmit, true, '保存中…');
      try {
        await MC.api('/api/rename', { method: 'POST', json: { type: type, id: Number(id), name: name } });
        renameDialog.close();
        MC.snack('名称已更新', 'success');
        setTimeout(() => location.reload(), 350);
      } catch (err) {
        handleApiError(err, 'renameError');
      } finally {
        setBusy(renameSubmit, false);
      }
    });
  }

  /* --------------------------------------------------------------- delete */
  const deleteDialog = document.getElementById('deleteDialog');
  const deleteConfirm = document.getElementById('deleteConfirm');
  let pendingDelete = null;

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="delete"]');
    if (!target) return;
    pendingDelete = { type: target.dataset.itemType, id: Number(target.dataset.itemId) };
    document.getElementById('deleteName').textContent = target.dataset.itemName || '该项目';
    MC.openDialog(deleteDialog);
  });

  if (deleteConfirm) {
    deleteConfirm.addEventListener('click', async () => {
      if (!pendingDelete) return;
      setBusy(deleteConfirm, true, '删除中…');
      try {
        await MC.api('/api/delete', { method: 'POST', json: pendingDelete });
        deleteDialog.close();
        MC.snack('已删除', 'success');
        setTimeout(() => location.reload(), 350);
      } catch (err) {
        handleApiError(err);
      } finally {
        setBusy(deleteConfirm, false);
        pendingDelete = null;
      }
    });
  }

  /* --------------------------------------------------------------- account */
  const accountDialog = document.getElementById('accountDialog');
  const accountForm = document.getElementById('accountForm');
  const accountSubmit = document.getElementById('accountSubmit');

  document.querySelectorAll('[data-dialog-open="accountDialog"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!accountForm) return;
      accountForm.reset();
      const username = document.getElementById('accountUsername');
      if (username) username.value = CONFIG.username || '';
      showFieldError('accountError', '');
    });
  });

  if (accountForm) {
    accountForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = document.getElementById('accountUsername').value.trim();
      const currentPassword = document.getElementById('accountCurrentPassword').value;
      const newPassword = document.getElementById('accountNewPassword').value;
      const confirmPassword = document.getElementById('accountConfirmPassword').value;

      if (!currentPassword) {
        showFieldError('accountError', '请输入当前密码。');
        return;
      }
      if (newPassword && newPassword.length < 6) {
        showFieldError('accountError', '新密码至少需要 6 个字符。');
        return;
      }
      if (newPassword !== confirmPassword) {
        showFieldError('accountError', '两次输入的新密码不一致。');
        return;
      }

      setBusy(accountSubmit, true, '保存中…');
      showFieldError('accountError', '');
      try {
        const data = await MC.api('/api/account', {
          method: 'POST',
          json: {
            username: username,
            current_password: currentPassword,
            new_password: newPassword,
            confirm_password: confirmPassword
          }
        });
        CONFIG.username = data.username;
        accountDialog.close();
        MC.snack(
          data.password_changed ? '账户和密码已更新' : '账户已更新',
          'success'
        );
        setTimeout(() => location.reload(), 450);
      } catch (err) {
        handleApiError(err, 'accountError');
      } finally {
        setBusy(accountSubmit, false);
      }
    });
  }

  /* --------------------------------------------------------------- upload */
  const uploadDialog = document.getElementById('uploadDialog');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const uploadList = document.getElementById('uploadList');
  const uploadStart = document.getElementById('uploadStart');
  const uploadProgress = document.getElementById('uploadProgress');
  const uploadBar = document.getElementById('uploadBar');
  const uploadProgressLabel = document.getElementById('uploadProgressLabel');
  const uploadError = document.getElementById('uploadError');

  let selectedFiles = [];
  let uploading = false;
  const allowed = new Set(
    (fileInput ? fileInput.accept : '')
      .split(',')
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
  );

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
  }

  function renderSelected() {
    if (!uploadList) return;
    uploadList.innerHTML = '';
    selectedFiles.forEach((file, index) => {
      const row = document.createElement('div');
      row.className = 'upload-row';
      const valid = allowed.has(extOf(file.name));
      row.innerHTML =
        MC.icon(valid ? 'file' : 'warning') +
        '<span class="fname"></span>' +
        '<span class="fsize"></span>' +
        '<button class="icon-btn" type="button" style="width:28px;height:28px" aria-label="移除">' +
        MC.icon('close', 'icon-sm') +
        '</button>';
      row.querySelector('.fname').textContent = file.name;
      row.querySelector('.fsize').textContent = valid ? MC.formatSize(file.size) : '格式不支持';
      row.querySelector('button').addEventListener('click', () => {
        selectedFiles.splice(index, 1);
        renderSelected();
      });
      uploadList.appendChild(row);
    });
    if (uploadStart) uploadStart.disabled = uploading || selectedFiles.length === 0;
  }

  function makeBatches(files) {
    // Keep each HTTP request small enough to survive slow uplinks and reverse
    // proxy / worker timeouts. A single oversized file gets its own batch.
    const MAX_BYTES = 8 * 1024 * 1024;
    const MAX_FILES = 8;
    const batches = [];
    let current = [];
    let currentBytes = 0;
    files.forEach((file) => {
      if (current.length && (currentBytes + file.size > MAX_BYTES || current.length >= MAX_FILES)) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += file.size;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  function addFiles(fileList) {
    if (!fileList || uploading) return;
    const errors = [];
    Array.from(fileList).forEach((file) => {
      if (!allowed.has(extOf(file.name))) {
        errors.push(file.name + '：不支持该格式');
        return;
      }
      const duplicate = selectedFiles.some((f) => f.name === file.name && f.size === file.size);
      if (!duplicate) selectedFiles.push(file);
    });
    if (errors.length) showFieldError('uploadError', errors.join('；'));
    else showFieldError('uploadError', '');
    renderSelected();
  }

  document.querySelectorAll('[data-dialog-open="uploadDialog"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (uploading) return;
      selectedFiles = [];
      renderSelected();
      showFieldError('uploadError', '');
      if (uploadProgress) uploadProgress.hidden = true;
      if (uploadBar) uploadBar.style.width = '0%';
      if (uploadProgressLabel) uploadProgressLabel.textContent = '';
    });
  });

  if (dropzone) {
    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
      addFiles(event.dataTransfer.files);
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      addFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  if (uploadStart) {
    uploadStart.addEventListener('click', async () => {
      if (!selectedFiles.length || uploading) return;
      uploading = true;
      uploadStart.disabled = true;
      if (uploadProgress) uploadProgress.hidden = false;
      if (uploadBar) uploadBar.style.width = '0%';
      if (uploadProgressLabel) uploadProgressLabel.textContent = '准备上传…';
      showFieldError('uploadError', '');
      const batches = makeBatches(selectedFiles);
      const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0) || 1;
      let doneBytes = 0;
      let uploaded = 0;
      const errors = [];
      try {
        for (let i = 0; i < batches.length; i += 1) {
          const batch = batches[i];
          const batchBytes = batch.reduce((sum, file) => sum + file.size, 0);
          if (uploadProgressLabel) {
            uploadProgressLabel.textContent = '上传中 · 第 ' + (i + 1) + '/' + batches.length + ' 批';
          }
          const data = await MC.upload(batch, CONFIG.folderId, (ratio) => {
            const pct = Math.round(((doneBytes + ratio * batchBytes) / totalBytes) * 100);
            if (uploadBar) uploadBar.style.width = pct + '%';
            if (uploadProgressLabel) {
              uploadProgressLabel.textContent =
                '上传中 ' + pct + '% · 第 ' + (i + 1) + '/' + batches.length + ' 批';
            }
          });
          uploaded += data.uploaded.length;
          if (data.errors && data.errors.length) errors.push(...data.errors);
          doneBytes += batchBytes;
          if (uploadBar) uploadBar.style.width = Math.round((doneBytes / totalBytes) * 100) + '%';
        }
        if (uploadProgressLabel) uploadProgressLabel.textContent = '上传完成 · ' + uploaded + ' 个文件';
        MC.snack('已上传 ' + uploaded + ' 个文件', 'success');
        if (errors.length) {
          setTimeout(() => MC.snack(errors.join('；'), 'error', 6000), 600);
        }
        uploadDialog.close();
        setTimeout(() => location.reload(), 500);
      } catch (err) {
        const suffix = uploaded ? '（已成功 ' + uploaded + ' 个，可关闭后重试剩余文件）' : '';
        showFieldError('uploadError', err.message + suffix);
        if (uploadProgressLabel) uploadProgressLabel.textContent = '上传未完成';
      } finally {
        uploading = false;
        uploadStart.disabled = selectedFiles.length === 0;
      }
    });
  }

  /* --------------------------------------------------------------- search key */
  function wireBrowseShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      const input = document.querySelector('.search-pill input[type="search"]');
      if (input) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  wireBrowseShortcuts();
})();
