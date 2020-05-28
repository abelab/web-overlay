<template>
    <div class="chat">
        <h1>Simple Chat</h1>
        <div style="width: 400px; margin: 0 auto;">
            <div class="input">
                <form @submit.prevent="enter">
                    <input
                        type="text"
                        v-model="inputText"
                        placeholder="what are you doing?"
                    />
                    <button class="button" type="submit">Send!</button>
                </form>
            </div>
            <div v-for="item in articles" v-key="item.index" class="article">
                <div class="header">
                    <span class="handle-and-date"
                        >@{{ item.handle }}&nbsp;{{
                            new Date(item.date).toLocaleString()
                        }}</span
                    >
                    <span class="index">{{ item.index }}</span>
                </div>
                <div class="text">
                    {{ item.text }}
                </div>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
import { Component, Prop, Vue, Watch } from "vue-property-decorator";
import { ChatApp, ChatArticle } from "@/common/chat";

@Component
export default class Chat extends Vue {
    @Prop() public app?: ChatApp;
    public inputText = "";
    public trigger = 0;

    public created() {
        this.appSet();
    }

    @Watch("app")
    public appSet() {
        if (this.app) {
            this.app.onUpdates(() => {
                this.trigger++; // to invoke articles() from Vue.js
            });
        }
    }

    public get articles(): ChatArticle[] {
        this.trigger; // to make Vue.js call articles()
        const a: ChatArticle[] = [];
        if (!this.app || !this.app.articleMap) {
            return [];
        }
        Array.from(this.app.articleMap.keys())
            .sort((a, b) => b - a)
            .forEach((ind) => a.push(this.app!.articleMap.get(ind)!));
        return a;
    }

    public enter(): void {
        if (this.inputText && this.inputText !== "") {
            this.app?.sendArticle(this.inputText).catch((err) => {
                this.$swal({
                    title: "Multicast Error!",
                    icon: "error",
                    text: err.toString(),
                });
            });
            this.inputText = "";
        }
    }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.button {
    margin: 0 20px;
    padding: 5px 10px;
    font-size: 110%;
    text-decoration: none;
    display: inline;
    text-align: center;
    color: #ffffff;
    background: #008ddd;
    border-radius: 10px 10px 10px 10px;
    -webkit-border-radius: 10px 10px 10px 10px;
    -moz-border-radius: 10px 10px 10px 10px;
}
input {
    font-size: large;
}
.input {
    margin: 0.5ex;
}
.article {
    border-color: #a0a0a0;
    border-width: 0.5px;
    border-style: solid;
    padding: 0.5ex 0.5em;
}
.header,
.text {
    text-align: left;
    display: table;
    width: 100%;
}
.handle-and-date {
    display: table-cell;
    text-align: left;
}
.index {
    display: table-cell;
    text-align: right;
    color: #cccccc;
}
</style>
