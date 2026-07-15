export default function PelotaTenis({ size = 27, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img"
         aria-label="pelota de tenis"
         style={{ verticalAlign: 'middle', marginLeft: 6, ...style }}>
      <circle cx="12" cy="12" r="10" fill="#9DBF3B"/>
      <path d="M4.5 5.5 C 9 9, 9 15, 4.5 18.5" fill="none"
            stroke="#F5F5EE" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M19.5 5.5 C 15 9, 15 15, 19.5 18.5" fill="none"
            stroke="#F5F5EE" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}
