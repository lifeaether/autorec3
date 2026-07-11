/* ui.js — 共通 UI プリミティブ (toast 通知 / confirm ダイアログ)。
 * vanilla・ビルド不要。window.toast / window.confirmDialog を公開し、app.js より前に読み込む。
 * alert()/confirm() の置き換え用。confirm ダイアログは既存 .modal / .modal-overlay CSS を再利用する。
 */
(function () {
    'use strict';

    // --- toast ---------------------------------------------------------------
    const TOAST_ICONS = {
        info: 'ph-info',
        success: 'ph-check-circle',
        warn: 'ph-warning',
        error: 'ph-x-circle',
    };

    function ensureToastContainer() {
        let c = document.getElementById('toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'toast-container';
            c.className = 'toast-container';
            document.body.appendChild(c);
        }
        return c;
    }

    // toast(message, {type='info'|'success'|'warn'|'error', ms=3000})
    function toast(message, opts) {
        opts = opts || {};
        const type = opts.type || 'info';
        const ms = opts.ms == null ? 3000 : opts.ms;
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.innerHTML = '<i class="ph-fill ' + (TOAST_ICONS[type] || TOAST_ICONS.info) + '"></i>' +
                       '<span class="toast-msg"></span>';
        el.querySelector('.toast-msg').textContent = message;
        ensureToastContainer().appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));

        let removed = false;
        function remove() {
            if (removed) return;
            removed = true;
            el.classList.remove('show');
            el.addEventListener('transitionend', () => el.remove(), { once: true });
            setTimeout(() => el.remove(), 400); // transition が来ない場合のフォールバック
        }
        if (ms > 0) setTimeout(remove, ms);
        el.addEventListener('click', remove);
        return el;
    }

    // --- confirm dialog ------------------------------------------------------
    // confirmDialog(message, {okLabel, cancelLabel, danger}) -> Promise<boolean>
    function confirmDialog(message, opts) {
        opts = opts || {};
        const okLabel = opts.okLabel || 'OK';
        const cancelLabel = opts.cancelLabel || 'キャンセル';
        const danger = !!opts.danger;

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay confirm-overlay active';

            const dialog = document.createElement('div');
            dialog.className = 'modal confirm-dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');

            const msgEl = document.createElement('div');
            msgEl.className = 'confirm-message';
            msgEl.textContent = message; // textContent + CSS white-space:pre-line で改行保持

            const actions = document.createElement('div');
            actions.className = 'modal-actions confirm-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-secondary';
            cancelBtn.textContent = cancelLabel;

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
            okBtn.textContent = okLabel;

            actions.append(cancelBtn, okBtn);
            dialog.append(msgEl, actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            let done = false;
            function close(result) {
                if (done) return;
                done = true;
                document.removeEventListener('keydown', onKey);
                overlay.classList.remove('active');
                overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
                setTimeout(() => overlay.remove(), 400);
                resolve(result);
            }
            function onKey(e) {
                if (e.key === 'Escape') close(false);
                else if (e.key === 'Enter') close(true);
            }

            cancelBtn.addEventListener('click', () => close(false));
            okBtn.addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
            document.addEventListener('keydown', onKey);
            requestAnimationFrame(() => okBtn.focus());
        });
    }

    window.toast = toast;
    window.confirmDialog = confirmDialog;
})();
