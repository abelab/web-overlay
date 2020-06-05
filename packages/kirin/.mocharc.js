process.env.NODE_ENV = 'test';
module.exports = {
  ui: 'mocha-typescript',
  require: 'ts-node/register/transpile-only',
  extension: ['ts']
}
