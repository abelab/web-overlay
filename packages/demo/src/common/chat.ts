import {
    Callbacks,
    Deferred,
    EndOfReply,
    Manager,
    RequestMessageSpec,
    serializable,
} from "@web-overlay/manager";
import {
    DdllNode,
    MulticastReply,
    MulticastRequest,
    PStoreDdll,
    PStoreError,
} from "@web-overlay/kirin";

export interface ChatArticle {
    index: number;
    date: number;
    handle: string;
    text: string;
}

@serializable
export class ChatRequest extends MulticastRequest<ChatRequest, ChatReply> {
    public chat?: ChatApp; // automatic

    constructor(manager: Manager, public article: ChatArticle) {
        super(manager);
    }

    public getSpec(): RequestMessageSpec {
        return { ...super.getSpec(), replyClassName: ChatReply.name };
    }

    public onReceive(): void {
        if (!this.chat) {
            console.warn("no .chat is set");
            return;
        }
        this.chat.chatReceive(this);
        const reply = new ChatReply(this);
        this.sendReply(reply);
    }
    public reduce(a: ChatReply, b: ChatReply): ChatReply {
        return new ChatReply(this);
    }
}

@serializable
export class ChatReply extends MulticastReply<ChatRequest, ChatReply> {
    constructor(req: ChatRequest) {
        super(req);
    }
}

export class ChatApp {
    private ddllnode: DdllNode;
    private pStore: PStoreDdll;
    private handle: string;
    public articleMap = new Map<number, ChatArticle>();
    private nextIndex = 0;
    private _onUpdates = new Callbacks();
    private fetching = false;

    constructor(ddllnode: DdllNode) {
        this.ddllnode = ddllnode;
        this.pStore = ddllnode as PStoreDdll;
        const manager = this.ddllnode.manager;
        manager.registerApp(ddllnode.getKey(), "chat", this);
        this.handle = ddllnode.getKey();
        this.fetch().catch(() => {
            /* empty */
        });
        // fetch articles every 30 second
        // note: we use DdllNode's timer so that timer is stopped if DdllNode is destroyed.
        this.ddllnode.cleaner.startIntervalTimer(
            this.ddllnode.manager,
            "chat-periodic-fetch",
            30 * 1000,
            () =>
                this.fetch().catch(() => {
                    /* empty */
                })
        );
    }

    public onUpdates(func: () => void): void {
        this._onUpdates.addCallback(func);
    }

    private async fetch(): Promise<void> {
        const doFetch = async () => {
            let next = this.nextIndex;
            const N = 100;
            while (true) {
                let articles: ChatArticle[];
                try {
                    articles = (await this.pStore.rawGetMulti(
                        "chat0",
                        next,
                        next + N
                    )) as ChatArticle[];
                } catch (err) {
                    break;
                }
                articles.forEach((m) => {
                    if (m) {
                        this.articleMap.set(Number(m.index), m);
                        next = m.index + 1;
                    }
                });
                if (!articles[N - 1]) {
                    break;
                }
            }
            this.nextIndex = next;
            this._onUpdates.invoke();
        };
        /* start */
        if (this.fetching) {
            return;
        }
        this.fetching = true;
        try {
            await doFetch();
        } catch {
            // empty
        } finally {
            this.fetching = false;
        }
    }

    public async sendArticle(text: string): Promise<void> {
        let m: ChatArticle;
        while (true) {
            m = {
                index: this.nextIndex,
                handle: this.handle,
                date: Date.now(),
                text: text,
            };
            try {
                await this.pStore.rawPut("chat0", m, {
                    index: m.index,
                    noOverwrite: true,
                });
                break; // put succeeded!
            } catch (err) {
                if (err.message === PStoreError.OVERWRITE_FORBIDDEN) {
                    // fetch undelivered messages and update this.nextIndex
                    await this.fetch();
                } else {
                    throw err;
                }
            }
        }
        this.nextIndex++;
        const defer = new Deferred<void>();
        let rep: ChatReply | undefined;
        const msg = new ChatRequest(this.ddllnode.manager, m);
        msg.onReply((reply) => {
            if (reply instanceof Error) {
                console.warn("[Multicast Error: " + reply.toString() + "]");
                defer.reject(reply);
            } else if (reply instanceof EndOfReply) {
                console.log("[Multicast Succeeded]");
                defer.resolve();
            } else {
                rep = !rep ? reply : msg.reduce(rep, reply);
            }
        });
        this.ddllnode.multicast("0", "0", msg);
        await defer.promise;
    }

    public chatReceive(msg: ChatRequest) {
        const index = Number(msg.article.index);
        this.nextIndex = Math.max(this.nextIndex, index);
        this.articleMap.set(index, msg.article);
        this._onUpdates.invoke();
    }
}
