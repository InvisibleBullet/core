import EventBus from 'delightful-bus'
import { pick } from 'nanoutils'
import { normalizeOptions } from './normalize'

const composeHooks = function composeHooks(options, debugStack = []) {
  let idx = 0

  const withPayload = payload => {
    if (!options.hooks[idx]) {
      options.update(payload)

      return Promise.resolve().then(() => options.final(payload))
    }
    return new Promise(resolve => {
      let isResolved = false

      const tryResolve = payload => {
        if (process.env.NODE_ENV !== 'production' && isResolved) {
          console.error(
            `[Apicase: hooks] Attempt to resolve ${
              options.type
            }[${idx}] hook twice:`
          )
          return
        }

        isResolved = true
        resolve(payload)
        return payload
      }

      const changeFlow = newFlow => payload => tryResolve(newFlow(payload))

      const ctx = Object.assign(
        options.createContext(payload, { changeFlow }),
        {
          next(payload) {
            idx++
            options.update(payload)
            return tryResolve(withPayload(payload))
          }
        }
      )

      options.hooks[idx](ctx)
    })
  }

  return withPayload
}

const pickState = pick([
  'success',
  'pending',
  'cancelled',
  'payload',
  'result',
  'meta'
])

/**
 * Function that starts request
 *
 * @function doRequest
 * @param {Object} request Object with payload, hooks and meta info
 * @returns {Request} Thenable object with state, .on() and .cancel() methods
 */

/**
 * @typedef {Object} Request
 * @property {State} state State of request
 * @property {EventHandler} on Subscrube to request events
 * @property {CancelRequest} cancel Cancel request
 */

/**
 * State of query
 *
 * @typedef {Object} State
 * @property {boolean} success Sets to true when request is resolved
 * @property {boolean} pending true until request is finished
 * @property {Object} payload Request payload
 * @property {Result} result Adapter state
 */

/**
 * Subscribe to request events
 *
 * @callback EventHandler
 * @param {string} type Event type
 * @param {Function} callback Event handler
 */

/**
 * Cancel request
 *
 * @callback CancelRequest
 */

/**
 * Adapter object
 *
 * @typedef {Object} Adapter
 * @property {Function} createState Creates adapter state
 * @property {Function} callback Contains adapter logic
 * @property {Function} merge Contains merge strategies
 * @property {Function} convert Is applied to request payload before request
 */

/**
 * Create a request callback with choosed adapter
 *
 * @param {Adapter} adapter Adapter instance
 * @returns {doRequest} Callback that starts request
 */

const apicase = adapter => req => {
  req.adapter = adapter
  // Prepare
  req = req._isNormalized ? req : normalizeOptions(req)

  if ('options' in req) {
    console.warn(
      `[Apicase.deprecated] req.options and delayed requests are now deprecated. Use https://github.com/apicase/spawner instead`
    )
  }

  // All data
  const bus = new EventBus()

  let cancelCallback = () => {}

  const throwError = error => {
    bus.emit('error', error)
    throw error
  }

  const res = {
    meta: req.meta,
    success: false,
    pending: true,
    cancelled: false,
    payload: {},
    result: 'createState' in req.adapter ? req.adapter.createState() : null,
    onDone: cb => {
      bus.on('done', cb)
      return res
    },
    onFail: cb => {
      bus.on('fail', cb)
      return res
    },
    cancel: () => {
      return Promise.resolve(cancelCallback()).then(() => {
        setState({ success: false, pending: false, cancelled: true })
        bus.emit('cancel', pickState(res))
      })
    }
  }

  bus.injectObserverTo(res)

  const doRequest = function doRequest(payload) {
    return new Promise(function request(resolve, reject) {
      try {
        const cb = req.adapter.callback({
          emit: bus.emit,
          payload: req.adapter.convert ? req.adapter.convert(payload) : payload,
          result: res.result,
          resolve: function resolveAdapter(result) {
            resolve(done(result))
          },
          reject: function rejectAdapter(result) {
            resolve(fail(result))
          },
          setCancelCallback: cb => {
            cancelCallback = cb
          }
        })
        if (cb && cb.then) {
          cb.catch(reject)
        }
      } catch (err) {
        reject(err)
      }
    }).catch(throwError)
  }

  const setState = diff => {
    const prev = pickState(res)
    const next = Object.assign(prev, diff)
    bus.emit('change:state', {
      prev: prev,
      next: next,
      diff: diff
    })
    Object.assign(res, next)
  }

  const before = composeHooks({
    hooks: req.hooks.before,
    update: next => {
      const prev = res.payload
      bus.emit('change:payload', {
        prev: prev,
        next: next
      })

      res.payload = next
    },
    createContext: (payload, { changeFlow }) => ({
      meta: req.meta,
      payload: payload,
      done: changeFlow(done),
      fail: changeFlow(fail)
    }),
    final: doRequest
  })

  const done = composeHooks({
    hooks: req.hooks.done,
    update: next => {
      const prev = res.result
      bus.emit('change:result', {
        prev: prev,
        next: next
      })

      res.result = next
      res.pending = false
      res.success = true
    },
    createContext: (result, { changeFlow }) => ({
      meta: req.meta,
      payload: res.payload,
      result: result,
      fail: changeFlow(fail)
    }),
    final: result => {
      bus.emit('done', result, pickState(res))
      bus.emit('finish', result, pickState(res))
      return pickState(res)
    }
  })

  const fail = composeHooks({
    hooks: req.hooks.fail,
    update: next => {
      const prev = res.result
      bus.emit('change:result', {
        prev: prev,
        next: next
      })

      res.result = next
      res.pending = false
      res.success = false
    },
    createContext: (result, { changeFlow }) => ({
      meta: req.meta,
      payload: res.payload,
      result: result,
      done: changeFlow(done),
      retry: changeFlow(before)
    }),
    final: result => {
      bus.emit('fail', result, pickState(res))
      bus.emit('finish', result, pickState(res))
      return pickState(res)
    }
  })

  res.promise = before(req.payload)
  res.then = cb => res.promise.then(cb)
  res.catch = cb => res.promise.catch(cb)

  return res
}

export { apicase }
