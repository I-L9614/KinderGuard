// Test-only. On slow runners (Windows CI) the in-memory MongoDB builds indexes after the first requests,
// so the production gate activeUniqueIndexPresent() (which reads the live index list) answers "missing" and
// license creation returns 503. Here the gate's read waits, bounded, for Mongoose to finish building the
// License and LicenseType indexes. The gate and the production code are unchanged; if the build never
// finishes, the original read still runs and the test fails as before.
import mongoose from 'mongoose';
import License from '../../src/models/License.js';
import LicenseType from '../../src/models/LicenseType.js';

const waitFor = (promise, ms) => { let t; return Promise.race([promise.catch(() => {}), new Promise((r) => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); };
const original = License.collection.indexes.bind(License.collection);
License.collection.indexes = async (...args) => {
  if (mongoose.connection.readyState === 1) await waitFor(Promise.all([License.init(), LicenseType.init()]), 15000);
  return original(...args);
};
