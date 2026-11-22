import express from 'express';

/** Passes errors from async handlers to Express (Express 4 only catches errors thrown synchronously). */
export const handle = (fn) =>
  typeof fn !== 'function' || fn.length === 4
    ? fn
    : (req, res, next) => {
        try {
          const result = fn(req, res, next);
          if (result && typeof result.then === 'function') result.catch(next);
        } catch (err) {
          next(err);
        }
      };

/** express.Router() whose route handlers and middleware may be async. */
export function Router() {
  const router = express.Router();
  for (const method of ['get', 'post', 'patch', 'put', 'delete', 'use', 'all']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(handle) : handle(a))));
  }
  return router;
}
