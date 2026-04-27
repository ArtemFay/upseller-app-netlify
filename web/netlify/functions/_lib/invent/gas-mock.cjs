/**
 * Returns a <script> block that mocks google.script.run and google.script.host
 * for local development. Injected before </body> by the dev server.
 *
 * google.script.run calls are proxied to a JSON endpoint inside the Netlify app.
 * google.script.host.close() is mocked as a no-op (or history.back).
 */

function getGasMockScript(endpoint) {
  const apiEndpoint = endpoint || '/api/invent-run';
  return `
<script>
/* === DEV MODE: google.script mock === */
(function() {
  if (typeof google !== 'undefined' && google.script) return; // real GAS — skip

  window.google = window.google || {};
  google.script = google.script || {};

  /**
   * google.script.run mock.
   * Usage:  google.script.run.withSuccessHandler(fn).withFailureHandler(fn).myFunction(arg1, arg2)
   */
  google.script.run = new Proxy({}, {
    get(target, prop) {
      // Builder state held per chain
      let _success = function() {};
      let _failure = function(err) { console.error('[gas-mock] unhandled error:', err); };

      const builder = new Proxy({}, {
        get(_, builderProp) {
          if (builderProp === 'withSuccessHandler') {
            return function(fn) { _success = fn; return builder; };
          }
          if (builderProp === 'withFailureHandler') {
            return function(fn) { _failure = fn; return builder; };
          }
          if (builderProp === 'withUserObject') {
            return function() { return builder; };
          }
          // Actual function call
          return function(...args) {
            console.log('[gas-mock] calling', builderProp, args);
            fetch('${apiEndpoint}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ functionName: builderProp, args: args })
            })
            .then(function(res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
            .then(function(data) {
              if (data.error) {
                _failure({ message: data.error });
              } else {
                _success(data.result);
              }
            })
            .catch(function(err) {
              _failure(err);
            });
          };
        }
      });

      // Entry: google.script.run.withSuccessHandler(...) or google.script.run.myFunction(...)
      if (prop === 'withSuccessHandler') {
        return function(fn) { _success = fn; return builder; };
      }
      if (prop === 'withFailureHandler') {
        return function(fn) { _failure = fn; return builder; };
      }
      if (prop === 'withUserObject') {
        return function() { return builder; };
      }
      // Direct call: google.script.run.myFunction(...)
      return function(...args) {
        console.log('[gas-mock] calling', prop, args);
        fetch('${apiEndpoint}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ functionName: prop, args: args })
        })
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (data.error) {
            _failure({ message: data.error });
          } else {
            _success(data.result);
          }
        })
        .catch(function(err) {
          _failure(err);
        });
      };
    }
  });

  /**
   * google.script.host mock.
   */
  google.script.host = {
    close: function() {
      console.log('[gas-mock] google.script.host.close() — redirecting back');
      window.history.back();
    },
    setHeight: function() {},
    setWidth: function() {}
  };

  console.log('[gas-mock] google.script mock active — API calls go to ${apiEndpoint}');
})();
</script>`;
}

module.exports = { getGasMockScript };
