export function generateRandomId(): string {
    let s = "";
    for (let i = 0; i < 8; i++) {
        const hex = Math.floor(Math.random() * 16).toString(16);
        s += hex;
    }
    return s;
}
