module.exports = {
  apps: [{
    name: "cloudbuildx-worker",
    script: "dist/index.js",
    instances: 3,
    exec_mode: "cluster",
    env: {
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: 6379,
    }
  }]
}
