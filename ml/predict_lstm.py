import os, json, argparse
import numpy as np
import torch
from data import load_dataset, apply_standardizer, make_sequences, FEATURES
from lstm_model import LSTMClassifier

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="../datasets/lstm_dataset.csv")
    parser.add_argument("--modeldir", default="../models/lstm_v1")
    parser.add_argument("--tickers", default="", help="comma-separated to score (leave empty for all)")
    parser.add_argument("--seq-len", type=int, default=30)
    args = parser.parse_args()

    # load meta & scaler
    with open(os.path.join(args.modeldir, "meta.json")) as f:
        meta = json.load(f)
    with open(os.path.join(args.modeldir, "scaler.json")) as f:
        stats = json.load(f)
    seq_len = meta.get("seq_len", args.seq_len)

    tickers = [t.strip() for t in args.tickers.split(",") if t.strip()] if args.tickers else None
    df = load_dataset(args.csv, tickers)
    df = apply_standardizer(df, stats)

    X, y = make_sequences(df, seq_len=seq_len)
    if X.shape[0] == 0:
        print("No sequences to score.")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = LSTMClassifier(in_features=X.shape[-1], hidden_size=meta["hidden"], num_layers=meta["layers"], dropout=meta["dropout"]).to(device)
    model.load_state_dict(torch.load(os.path.join(args.modeldir, "model.pt"), map_location=device))
    model.eval()

    with torch.no_grad():
        logits = model(torch.tensor(X).to(device))
        probs = torch.sigmoid(logits).cpu().numpy()
        preds = (probs >= 0.5).astype(int)

    # Show last few
    print("Last 10 predictions (prob_up, pred):")
    for i in range(-10, 0):
        if i + len(probs) < 0: continue
        print(f"{probs[i]:.3f}\t{preds[i]}")

if __name__ == "__main__":
    main()
