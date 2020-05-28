import Vue from "vue";
import VueSweetalert2 from "vue-sweetalert2";
import App from "./App.vue";

Vue.config.productionTip = false;

Vue.use(VueSweetalert2);

new Vue({
    render: (h) => h(App),
}).$mount("#app");
