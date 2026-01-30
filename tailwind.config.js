import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';

export default {
  plugins: [forms, typography],
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        // Neutrals
        neutral: {
          0: '#FFFFFF',
          10: '#E6E6E6',
          20: '#CFCFCF',
          30: '#909090',
          40: '#848484',
          50: '#777777',
          60: '#5F5F5F',
          70: '#4D4D4D',
          80: '#454545',
          90: '#303030',
          100: '#191919',
          110: '#171717',
          120: '#000000'
        },
        // Primary
        primary: {
          blue30: '#3EA9F9',
          blue60: '#1890FF',
          blue90: '#0980D8',
          deep30: '#176FA5',
          deep60: '#015F9B',
          deep90: '#01568C',
          green30: '#8ECA6B',
          green60: '#82C45B',
          green90: '#75B052',
          green100: '#5D913C'
        },
        // Secondary accents
        accent: {
          slate30: '#ADBBD0',
          slate60: '#A3B3CB',
          slate90: '#92A1B7',
          navy30: '#475971',
          navy60: '#324661',
          navy90: '#2C3F57',
          orange30: '#FF883D',
          orange60: '#FF7B28',
          orange90: '#E66F26',
          gold30: '#F6C354',
          gold60: '#F5BC41',
          gold90: '#DCA93B',
          danger30: '#DC6127',
          danger60: '#D84F10',
          danger90: '#C2470D',
          peach30: '#F1A961',
          peach60: '#EF9F4F',
          peach90: '#D68F48',
          mint30: '#BCDACC',
          mint60: '#B4D6C6',
          mint90: '#A2C1B2',
          rosegray30: '#DFD5D7',
          rosegray60: '#DBD0D3',
          rosegray90: '#C5BBBE',
          brown30: '#B87631',
          brown60: '#AF681B',
          brown90: '#9E5E18',
          purple30: '#9A2CBB',
          purple60: '#8F15B4',
          purple90: '#8114A2',
          maroon30: '#722F59',
          maroon60: '#631747',
          maroon90: '#581540'
        },
        // Pastels - backgrounds only
        pastel: {
          blue30: '#CAD8ED',
          blue60: '#BAD3F7',
          cyan30: '#CBEDFF',
          cyan60: '#92D5F7',
          green30: '#E0F0D7',
          green60: '#BCDACC',
          yellow30: '#FFF7C5',
          yellow60: '#FCEE9A',
          pink30: '#FFE1EB',
          pink60: '#F6D4C7',
          beige30: '#FCEED2',
          beige60: '#F7D084',
          purple30: '#F4ECFF',
          purple60: '#E0D3F2'
        }
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        pill: '9999px'
      },
      boxShadow: {
        card: '0 2px 12px rgba(0,0,0,0.08)',
        hover: '0 6px 20px rgba(0,0,0,0.10)'
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif'
        ]
      },
      fontSize: {
        'label-xxl': ['42px', { lineHeight: '1.1', fontWeight: '700' }],
        'title-lg': ['35px', { lineHeight: '1.15', fontWeight: '700' }],
        'title-md': ['24px', { lineHeight: '1.2', fontWeight: '700' }],
        'label-lg': ['20px', { lineHeight: '1.25', fontWeight: '700' }],
        'field-value': ['18px', { lineHeight: '1.3', fontWeight: '600' }],
        'titlebar-title': ['17px', { lineHeight: '1.3', fontWeight: '700' }],
        body: ['16px', { lineHeight: '1.4' }],
        'list-item': ['15px', { lineHeight: '1.4' }],
        'tab-label': ['14px', { lineHeight: '1.35', fontWeight: '600' }],
        'label-sm': ['12px', { lineHeight: '1.35', fontWeight: '600' }]
      }
    }
  }
};
