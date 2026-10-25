"""Draws docs/chat-en-light.svg and docs/chat-en-dark.svg: the bot in a Telegram chat.

The texts match what the bot sends with LANGUAGE=en (src/i18n/en.ts). Run: python3 docs/render-chat.py
"""

from pathlib import Path

W = 720
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

PALETTES = {
    "light": dict(
        bg="#c9d9c0", pattern="#b9cdb0", header="#ffffff", title="#000000", muted="#8a979f",
        incoming="#ffffff", outgoing="#e2ffc7", text="#000000", link="#2a7ab8",
        quote="#e8f2fb", button="#000000", button_opacity="0.18", button_text="#ffffff",
        avatar="#3e8ee0", code="#c4283f", shadow="#00000022",
    ),
    "dark": dict(
        bg="#0e1621", pattern="#132030", header="#17212b", title="#f5f5f5", muted="#7d8b99",
        incoming="#182533", outgoing="#2b5278", text="#f5f5f5", link="#6ab3f3",
        quote="#1f3346", button="#ffffff", button_opacity="0.10", button_text="#f5f5f5",
        avatar="#3e8ee0", code="#ff8a80", shadow="#00000055",
    ),
}


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def line(x, y, parts, p):
    """parts: (text, style) with style in plain | bold | link | code | muted"""
    spans = []
    for text, style in parts:
        attrs = {
            "plain": f'fill="{p["text"]}"',
            "bold": f'fill="{p["text"]}" font-weight="600"',
            "link": f'fill="{p["link"]}"',
            "code": f'fill="{p["code"]}" font-family="{MONO}" font-size="14"',
            "muted": f'fill="{p["muted"]}" font-size="12"',
            "italic": f'fill="{p["muted"]}" font-style="italic" font-size="14"',
        }[style]
        spans.append(f"<tspan {attrs}>{esc(text)}</tspan>")
    return f'<text x="{x}" y="{y}" font-size="15" xml:space="preserve">{"".join(spans)}</text>'


def bubble(x, y, w, h, fill, p):
    return (
        f'<rect x="{x}" y="{y + 1}" width="{w}" height="{h}" rx="14" fill="{p["shadow"]}"/>'
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}"/>'
    )


def time(x, y, label, p):
    return f'<text x="{x}" y="{y}" font-size="12" fill="{p["muted"]}" text-anchor="end">{label}</text>'


def render(p) -> str:
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="878" viewBox="0 0 {W} 878" '
        f'font-family="{FONT}" role="img" aria-label="ETH Watch Bot in a Telegram chat">',
        '<defs><pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">'
        f'<circle cx="4" cy="4" r="1.6" fill="{p["pattern"]}"/>'
        f'<circle cx="18" cy="18" r="1.6" fill="{p["pattern"]}"/></pattern>'
        '<clipPath id="frame"><rect width="720" height="878" rx="16"/></clipPath></defs>',
        '<g clip-path="url(#frame)">',
        f'<rect width="{W}" height="878" fill="{p["bg"]}"/>',
        f'<rect width="{W}" height="878" fill="url(#dots)"/>',
        # header
        f'<rect width="{W}" height="60" fill="{p["header"]}"/>',
        f'<circle cx="40" cy="30" r="20" fill="{p["avatar"]}"/>',
        '<text x="40" y="36" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle">EW</text>',
        f'<text x="72" y="26" font-size="16" font-weight="600" fill="{p["title"]}">ETH Watch Bot</text>',
        f'<text x="72" y="45" font-size="13" fill="{p["muted"]}">bot</text>',
    ]

    # /watch from the user
    out.append(bubble(434, 80, 270, 40, p["outgoing"], p))
    out.append(line(448, 105, [("/watch vitalik.eth Vitalik", "link")], p))
    out.append(time(694, 113, "20:41", p))

    # reply
    out.append(bubble(16, 136, 540, 64, p["incoming"], p))
    out.append(line(30, 161, [("👀 Watching ", "plain"), ("Vitalik", "bold"), (" (", "plain"),
                              ("0xd8dA…6045", "link"), ("). I will report ETH and token", "plain")], p))
    out.append(line(30, 184, [("transfers and contract calls.", "plain")], p))
    out.append(time(546, 191, "20:41", p))

    # an outgoing transfer with "Details shown": what the transaction did and cost
    out.append(bubble(16, 216, 540, 184, p["incoming"], p))
    out.append(line(30, 242, [("🔔 ", "plain"), ("Vitalik", "bold"), (" · Ethereum · outgoing", "plain")], p))
    out.append(line(30, 266, [("⚙️ Call to ", "plain"), ("0xA0b8…eB48", "link"),
                              (" · ", "plain"), ("transfer", "bold"), ("(to ", "plain"),
                              ("0x28C6…1d60", "link"), (",", "plain")], p))
    out.append(line(30, 290, [("amount 250,000 USDC)", "plain")], p))
    out.append(line(30, 314, [("⬆️ Sent ", "plain"), ("250,000", "bold"), (" ", "plain"),
                              ("USDC", "link"), (" ($249,900) → ", "plain"), ("0x28C6…1d60", "link"),
                              (" · 🆕 first time", "plain")], p))
    out.append(line(30, 338, [("⛽ Fee 0.00042 ETH ($1.05)", "plain")], p))
    out.append(line(30, 362, [("💰 Balance: 12.5 ETH ($31,250)", "plain")], p))
    out.append(line(30, 386, [("Transaction", "link"), (" · block 21,004,117 · 25 Oct 20:58", "plain")], p))
    out.append(time(546, 391, "20:58", p))
    out.append(f'<rect x="16" y="406" width="540" height="40" rx="10" fill="{p["button"]}" '
               f'fill-opacity="{p["button_opacity"]}"/>')
    out.append(f'<text x="286" y="431" font-size="15" font-weight="500" fill="{p["button_text"]}" '
               'text-anchor="middle">🔕 Mute for 24 h</text>')

    # an approval with the default "Details under a spoiler": the chat list shows only
    # the first line; amounts, addresses and the link open on a tap
    out.append(bubble(16, 462, 540, 186, p["incoming"], p))
    out.append(line(30, 488, [("🚨 ", "plain"), ("Vitalik", "bold"), (" · Ethereum · token approval", "plain")], p))
    for y, width in ((500, 470), (524, 380), (548, 300)):
        out.append(f'<rect x="30" y="{y}" width="{width}" height="14" rx="7" fill="{p["muted"]}" '
                   'fill-opacity="0.35"/>')
    out.append(line(30, 586, [("If this was not you: revoke the approvals (revoke.cash)", "italic")], p))
    out.append(line(30, 608, [("and move the funds to a new wallet.", "italic")], p))
    out.append(line(30, 634, [("🧹 ", "plain"), ("Review and revoke approvals", "link"),
                              (" on revoke.cash", "plain")], p))
    out.append(time(546, 639, "21:02", p))

    # /messages on
    out.append(bubble(564, 666, 140, 40, p["outgoing"], p))
    out.append(line(578, 691, [("/messages on", "link")], p))

    # a message from a block
    out.append(bubble(16, 722, 540, 138, p["incoming"], p))
    out.append(line(30, 748, [("✉️ ", "plain"), ("Message in block 21,004,120", "bold"),
                              (" · Ethereum", "plain")], p))
    out.append(f'<rect x="30" y="760" width="512" height="56" rx="6" fill="{p["quote"]}"/>')
    out.append(f'<rect x="30" y="760" width="3" height="56" rx="1.5" fill="{p["link"]}"/>')
    out.append(line(44, 783, [("Happy birthday, Anya! May this line stay", "plain")], p))
    out.append(line(44, 805, [("on the blockchain forever.", "plain")], p))
    out.append(line(30, 840, [("0x1f9a…02bc", "link"), (" → ", "plain"), ("0xae7a…fE84", "link"),
                              (" · ", "plain"), ("Transaction", "link")], p))
    out.append(time(546, 851, "21:03", p))

    out.append("</g></svg>")
    return "\n".join(out) + "\n"


here = Path(__file__).parent
for name, palette in PALETTES.items():
    (here / f"chat-en-{name}.svg").write_text(render(palette), encoding="utf-8")
