module.exports = {
  apps: [{
    name: "cloudbuildx-worker",
    script: "dist/index.js",
    instances: 3,
    exec_mode: "cluster"
  }]
}
