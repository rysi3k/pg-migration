'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _fsExtra = require('fs-extra');

var _fsExtra2 = _interopRequireDefault(_fsExtra);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// Promise polyfill for ES5 compatibility
require('es6-promise').polyfill();

function log(level, message) {
  var obj = {
    datetime: Date.now(),
    severity: level,
    message: message
  };
  console.log(JSON.stringify(obj)); //eslint-disable-line no-console
}

var changesetExists = "SELECT id FROM dbchangelog WHERE id=$1";

function migrateAndStart(databaseClient, migrationsDir, cb) {
  log('info', 'Checking for migrations to perform');
  // Check whether we need to create the migration table itself
  databaseClient.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'dbchangelog'", [], function (err, res) {
    if (res.rowCount === 1) {
      migrate(databaseClient, migrationsDir, cb);
    } else {
      log('info', 'Creating the migration table');
      databaseClient.query("CREATE TABLE dbchangelog(id bigint, datetime timestamp with time zone);CREATE UNIQUE index changeset on dbchangelog(id);", function (err, res) {
        if (err) {
          return log('error', 'Could not create the migration table');
        }
        log('info', 'Created the migration table');
        migrate(databaseClient, migrationsDir, cb);
      });
    }
  });
}

function migrate(databaseClient, migrationsDir, cb) {
  _fsExtra2.default.readdir(migrationsDir, function (err, items) {
    if (err) {
      // In case of an error while fetching the migrations, error and abort
      log('error', 'Could not find changesets: ' + err);
      return;
    }

    // Create promises for applying the changesets. Filter the README and dbchangelog.sql files
    items.filter(function (e) {
      return e.indexOf('README.md') === -1 && e.indexOf('dbchangelog.sql') === -1;
    }).map(function (changeset) {
      // Skip the default changeloglock table and the readme describing the changesets
      if (changeset.indexOf('README.md') > -1 || changeset.indexOf('dbchangelog.sql') > -1) {
        return null;
      }
      var changesetCode = changeset.replace('.sql', '');
      log('info', 'Checking whether to apply changeset ' + changesetCode);
      return function () {
        return new Promise(function (resolve, reject) {
          databaseClient.query(changesetExists, [changesetCode], function (err, res) {
            if (err) {
              // An error occurred while checking if this changeset exists
              log('error', err);
              return reject();
            }
            if (res.rowCount === 1) {
              // This changeset is already applied
              log('info', 'No need to apply changeset ' + changesetCode);
              return resolve();
            }
            log('info', 'Applying changeset ' + changesetCode);
            // Read the file content
            var changesetContent = _fsExtra2.default.readFileSync('./migrations/' + changeset, 'UTF-8');
            var noTransaction = changesetContent.startsWith('-- NO TRANSACTION');
            databaseClient.query(noTransaction ? "SELECT 1" : "BEGIN", function (err) {
              databaseClient.query(changesetContent, function (err) {
                // Apply the changeset
                if (err) {
                  // Couldnt apply the changeset, probably an error in the migration. Reject the promise
                  log('error', 'Error applying the changeset: ' + err);
                  return reject();
                }
                databaseClient.query("INSERT INTO dbchangelog (id, datetime) VALUES ($1, NOW())", [changesetCode], function (err) {
                  // Save the value of the changeset to the database
                  if (err) {
                    return reject();
                  }
                  databaseClient.query(noTransaction ? "SELECT 1" : "COMMIT", function (err) {
                    if (err) {
                      return reject();
                    }
                    log('info', 'Finished applying changeset ' + changesetCode);
                    resolve();
                  });
                });
              });
            });
          });
        });
      };
    }).reduce(function (promise, task) {
      return promise.then(function () {
        return task();
      });
    }, Promise.resolve()).then(cb).catch(function () {
      log('error', 'One or more migrations failed to apply');
      process.exit();
    });
  });
}

exports.default = migrateAndStart;