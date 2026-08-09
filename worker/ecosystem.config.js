module.exports = {
  apps: [{
    name: "cloudbuildx-worker",
    script: "node_modules/.bin/tsx",
    args: "src/index.ts",
    instances: 3,
    exec_mode: "cluster",
    env: {
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: 6379,
    }
  }]
}
