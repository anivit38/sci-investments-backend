import os, json, argparse, math
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import TensorDataset, DataLoader

from data import load_dataset, time_split, fit_standardizer, apply_standardizer, make_sequences, FEATURES, LABEL
from lstm_model import LSTMClassifier

def set_seed(s=42):
    import random
    random.seed(s); np.random.seed(s); torch.manual_seed(s)

def train_one(model, loader, optimizer, device):
    model.train()
    loss_fn = nn.BCEWithLogitsLoss()
    total, correct, loss_sum = 0, 0, 0.0
    for xb, yb in loader:
        xb, yb = xb.to(device), yb.to(device)
        optimizer.zero_grad()
        logits = model(xb)
        loss = loss_fn(logits, yb)
        loss.backward()
        optimizer.step()
        with torch.no_grad():
            probs = torch.sigmoid(logits)
            preds = (probs >= 0.5).float()
            correct += (preds == yb).sum().item()
            total += yb.numel()
            loss_sum += loss.item() * yb.numel()
    return loss_sum/total, correct/total

@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    loss_fn = nn.BCEWithLogitsLoss()
    total, correct, loss_sum = 0, 0, 0.0
    for xb, yb in loader:
        xb, yb = xb.to(device), yb.to(device)
        logits = model(xb)
        loss = loss_fn(logits, yb)
        probs = torch.sigmoid(logits)
        preds = (probs >= 0.5).float()
        correct += (preds == yb).sum().item()
        total += yb.numel()
        loss_sum += loss.item() * yb.numel()
    return loss_sum/total, correct/total

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", default="../datasets/lstm_dataset.csv", help="Path to exported dataset CSV")
    parser.add_argument("--seq-len", type=int, default=30)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--hidden", type=int, default=64)
    parser.add_argument("--layers", type=int, default=1)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--patience", type=int, default=5)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--tickers", default="", help="comma-separated tickers subset")
    parser.add_argument("--outdir", default="../models/lstm_v1")
    args = parser.parse_args()

    set_seed(42)
    os.makedirs(args.outdir, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    tickers = [t.strip() for t in args.tickers.split(",") if t.strip()] if args.tickers else None
    df = load_dataset(args.csv, tickers)

    # time-based split
    df_train, df_val, df_test = time_split(df, train_frac=0.7, val_frac=0.15)

    # standardize on TRAIN only, apply to all
    stats = fit_standardizer(df_train)
    from data import save_stats
    save_stats(os.path.join(args.outdir, "scaler.json"), stats)

    df_train = apply_standardizer(df_train, stats)
    df_val   = apply_standardizer(df_val, stats)
    df_test  = apply_standardizer(df_test, stats)

    # make sequences
    Xtr, ytr = make_sequences(df_train, seq_len=args.seq_len)
    Xva, yva = make_sequences(df_val,   seq_len=args.seq_len)
    Xte, yte = make_sequences(df_test,  seq_len=args.seq_len)

    if Xtr.shape[0] == 0 or Xva.shape[0] == 0:
        raise RuntimeError("Not enough data after sequence building. Try reducing --seq-len or export more rows.")

    # loaders
    tr_ds = TensorDataset(torch.tensor(Xtr), torch.tensor(ytr))
    va_ds = TensorDataset(torch.tensor(Xva), torch.tensor(yva))
    te_ds = TensorDataset(torch.tensor(Xte), torch.tensor(yte))
    tr_dl = DataLoader(tr_ds, batch_size=args.batch, shuffle=True)
    va_dl = DataLoader(va_ds, batch_size=args.batch, shuffle=False)
    te_dl = DataLoader(te_ds, batch_size=args.batch, shuffle=False)

    # model
    model = LSTMClassifier(in_features=Xtr.shape[-1], hidden_size=args.hidden, num_layers=args.layers, dropout=args.dropout).to(device)
    optim = torch.optim.Adam(model.parameters(), lr=args.lr)

    # training loop with early stopping on val accuracy
    best_val_acc, patience_left = 0.0, args.patience
    for epoch in range(1, args.epochs+1):
        tr_loss, tr_acc = train_one(model, tr_dl, optim, device)
        va_loss, va_acc = evaluate(model, va_dl, device)
        print(f"Epoch {epoch:02d} | train loss {tr_loss:.4f} acc {tr_acc:.3f} | val loss {va_loss:.4f} acc {va_acc:.3f}")

        if va_acc > best_val_acc + 1e-4:
            best_val_acc = va_acc
            patience_left = args.patience
            torch.save(model.state_dict(), os.path.join(args.outdir, "model.pt"))
        else:
            patience_left -= 1
            if patience_left <= 0:
                print("Early stopping.")
                break

    # load best and evaluate on test
    model.load_state_dict(torch.load(os.path.join(args.outdir, "model.pt"), map_location=device))
    te_loss, te_acc = evaluate(model, te_dl, device)
    print(f"TEST  | loss {te_loss:.4f} acc {te_acc:.3f}")

    # Save meta
    meta = {
        "features": FEATURES,
        "label": LABEL,
        "seq_len": args.seq_len,
        "hidden": args.hidden,
        "layers": args.layers,
        "dropout": args.dropout,
        "test_accuracy": te_acc
    }
    with open(os.path.join(args.outdir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

if __name__ == "__main__":
    main()
