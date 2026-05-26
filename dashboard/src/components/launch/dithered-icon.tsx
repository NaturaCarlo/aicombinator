"use client";

type DitheredIconProps = {
  size?: number;
  className?: string;
};

export function DitheredIcon({ size = 80, className }: DitheredIconProps) {
  const r = size * 0.18;

  return (
    <div className={className} style={{ width: size, height: size, position: "relative" }}>
      {/* Ambient glow layers */}
      <div
        className="absolute inset-0 animate-pulse"
        style={{
          borderRadius: r,
          background: "radial-gradient(circle, rgba(255,102,0,0.5) 0%, transparent 70%)",
          filter: "blur(28px)",
          transform: "scale(1.6)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          borderRadius: r,
          background: "radial-gradient(circle, rgba(255,102,0,0.3) 0%, transparent 60%)",
          filter: "blur(48px)",
          transform: "scale(2.2)",
          animation: "icon-breathe 4s ease-in-out infinite",
        }}
      />

      {/* Main icon */}
      <div
        className="relative overflow-hidden"
        style={{
          width: size,
          height: size,
          borderRadius: r,
          background: "#ee6018",
          boxShadow: [
            "0 0 0 1px rgba(255,255,255,0.1) inset",
            "0 1px 0 rgba(255,255,255,0.15) inset",
            "0 -1px 0 rgba(0,0,0,0.15) inset",
            "0 8px 24px rgba(255,102,0,0.35)",
            "0 2px 8px rgba(0,0,0,0.2)",
          ].join(", "),
        }}
      >
        {/* Inner gradient for depth */}
        <div
          className="absolute inset-0"
          style={{
            borderRadius: r,
            background: "linear-gradient(170deg, rgba(255,255,255,0.18) 0%, transparent 40%, rgba(0,0,0,0.12) 100%)",
          }}
        />

        {/* Light sweep */}
        <div
          className="absolute inset-0"
          style={{
            borderRadius: r,
            background: "linear-gradient(105deg, transparent 0%, transparent 35%, rgba(255,255,255,0.25) 45%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0.25) 55%, transparent 65%, transparent 100%)",
            animation: "icon-sweep 4s ease-in-out infinite",
            animationDelay: "1s",
          }}
        />

        {/* The A letterform */}
        <svg
          viewBox="0 0 48 48"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="relative"
          style={{ width: size, height: size }}
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M21.5 11.78H26.5L36.5 37.3H32.5L28.85 28H19.15L15.5 37.3H11.5L21.5 11.78ZM24 15.63L20.52 24.5H27.48L24 15.63Z"
            fill="white"
            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.15))" }}
          />
        </svg>
      </div>

      <style jsx>{`
        @keyframes icon-sweep {
          0%, 100% { transform: translateX(-120%); }
          50%, 60% { transform: translateX(120%); }
        }
        @keyframes icon-breathe {
          0%, 100% { opacity: 0.5; transform: scale(2.0); }
          50% { opacity: 0.8; transform: scale(2.4); }
        }
      `}</style>
    </div>
  );
}
