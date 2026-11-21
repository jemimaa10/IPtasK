import { api } from '../api.js';
import { app } from '../state.js';
import { $, busy, takeAuthError, googleButton } from '../ui.js';

export function renderAuth(root, mode) {
  if (mode === 'recover') return renderRecover(root);
  const isLogin = mode === 'login';
  root.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      <a class="brand" href="/"><span class="brand-mark">iK</span><span class="brand-name">IPtas<b>K</b></span></a>
      <h1>${isLogin ? 'Welcome back' : 'Create your account'}</h1>
      <p>${isLogin ? 'Your group is waiting for your proof.' : 'Just a username and a password. You can set your display name and photo later.'}</p>
      <div id="google-box"></div>
      <form id="auth-form" class="card" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <input class="input" id="username" name="username" autocomplete="username" required minlength="3" maxlength="20" placeholder="e.g. jeremy_05">
          ${isLogin ? '' : '<small>3–20 characters: letters, numbers, _ or .</small>'}
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" id="password" name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="6" placeholder="${isLogin ? '••••••' : 'At least 6 characters'}">
          ${isLogin ? '<small><a href="#/recover">Forgot password?</a></small>' : ''}
        </div>
        ${isLogin ? '' : `
        <div class="field">
          <label for="password2">Confirm password</label>
          <input class="input" id="password2" type="password" autocomplete="new-password" required>
        </div>`}
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">${isLogin ? 'Log in' : 'Sign up'}</button>
      </form>
      <p class="auth-switch">${isLogin ? "Don't have an account? <a href=\"#/register\">Sign up</a>" : 'Already have an account? <a href="#/login">Log in</a>'}</p>
    </div>
  </div>`;

  const redirectError = takeAuthError();
  if (redirectError) $('#auth-error').textContent = redirectError;
  api('/auth/providers').then(({ google }) => {
    const box = $('#google-box');
    if (!google || !box) return;
    box.innerHTML = `${googleButton(isLogin ? 'Continue with Google' : 'Sign up with Google')}
      <div class="auth-or"><span>or with a username</span></div>`;
  }).catch(() => {});

  const form = $('#auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#auth-error');
    err.textContent = '';
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!isLogin && password !== $('#password2').value) {
      err.textContent = 'Passwords do not match.';
      return;
    }
    await busy(form.querySelector('button[type=submit]'), async () => {
      try {
        await api(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body: { username, password } });
        location.hash = isLogin ? '#/home' : '#/profile';
        await app.start();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });
}

function renderRecover(root) {
  root.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      <a class="brand" href="/"><span class="brand-mark">iK</span><span class="brand-name">IPtas<b>K</b></span></a>
      <h1>Reset your password</h1>
      <p>Use the recovery code you saved from your Profile page. Each code works once.</p>
      <form id="rec-form" class="card" novalidate>
        <div class="field">
          <label for="r-username">Username</label>
          <input class="input" id="r-username" name="username" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="r-code">Recovery code</label>
          <input class="input" id="r-code" name="code" autocomplete="off" required placeholder="XXXX-XXXX-XXXX" style="text-transform:uppercase;letter-spacing:.08em">
        </div>
        <div class="field">
          <label for="r-password">New password</label>
          <input class="input" id="r-password" name="password" type="password" autocomplete="new-password" required minlength="6" placeholder="At least 6 characters">
        </div>
        <div class="form-error" id="rec-error"></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Reset password</button>
      </form>
      <p class="auth-switch">No recovery code? The account can't be recovered without one, so make a new account and ask your leader to invite you again. <a href="#/login">Back to log in</a></p>
    </div>
  </div>`;

  const form = $('#rec-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rec-error');
    err.textContent = '';
    await busy(form.querySelector('button[type=submit]'), async () => {
      try {
        await api('/auth/recover', {
          method: 'POST',
          body: { username: form.username.value.trim(), code: form.code.value, password: form.password.value },
        });
        location.hash = '#/profile';
        await app.start();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  });
}
