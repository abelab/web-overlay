// vue.config.js
module.exports = {
    pages: {
        index: {
            entry: "src/main.ts",
            template: "public/index.html",
            filename: "index.html",
            title: "Web-Overlay Demo",
            chunks: ["chunk-vendors", "chunk-common", "index"],
        },
    },
    chainWebpack: (config) => {
        config.optimization.minimize(false);
    },
    lintOnSave: false,
};
