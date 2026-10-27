import { api } from '../api.js';
import { app } from '../state.js';
import { $, busy } from '../ui.js';

export function renderAuth(root, mode) {
  const isLogin = mode === 'login';
  root.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-card">
      <a class="brand" href="/"><span class="brand-mark">iK</span><span class="brand-name">IPtas<b>K</b></span></a>
      <h1>${isLogin ? 'Welcome back' : 'Create your account'}</h1>
      <p>${isLogin ? 'Your group is waiting for your proof.' : 'Just a username and a password. You can set your display name and photo later.'}</p>
      <form id="auth-form" class="card" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <input class="input" id="username" name="username" autocomplete="username" required minlength="3" maxlength="20" placeholder="e.g. jeremy_05">
          ${isLogin ? '' : '<small>3–20 characters: letters, numbers, _ or .</small>'}
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" id="password" name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="6" placeholder="${isLogin ? '••••••' : 'At least 6 characters'}">
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
