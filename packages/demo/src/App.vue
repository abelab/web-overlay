<template>
    <div id="app">
        <Main />
    </div>
</template>
<script lang="ts">
import { Component, Vue } from "vue-property-decorator";
import Main from "@/components/Main.vue";

@Component({
    components: {
        Main,
    },
})
export default class App extends Vue {}
</script>

<style>
#app {
    font-family: Avenir, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-align: center;
    color: #2c3e50;
}

table {
    border: 1px #97bdd6 solid;
    margin: 15px auto;
}

th {
    background-color: #97bdd6;
}

td {
    border-bottom: 1px #97bdd6 solid;
}

.btn-square {
    display: inline-block;
    font-size: large;
    padding: 0.5em 1em;
    text-decoration: none;
    background: #668ad8;
    color: #fff;
    border-bottom: solid 4px #627295;
    border-radius: 3px;
    margin: 1ex;
}
.btn-square:active {
    -webkit-transform: translateY(4px);
    transform: translateY(4px);
    border-bottom: none;
}
.btn-square:disabled {
    background: #ddeeff;
    border-bottom: solid 4px #aabbcc;
}

#nav {
    padding: 30px;
}

a {
    font-weight: bold;
    color: #2c3e50;
}

a:hover {
    color: #668ad8;
}
</style>
