import React from "react";
import { View, Image, TouchableOpacity, Text } from "react-native";
import { styles } from "./ImageGrid.styles";

type Props = {
	imagePath: string;
	onPressImage: (images: string[], index: number) => void;
};

export default function ImageGrid({ imagePath, onPressImage }: Props) {
	if (!imagePath) return null;

	let images: string[] = [];

	try {
		images = JSON.parse(imagePath);
	} catch {
		return null;
	}

	const MAX_VISIBLE = 5;
	const visibleImages = images.slice(0, MAX_VISIBLE);
	const remaining =
		images.length > MAX_VISIBLE ? images.length - MAX_VISIBLE : 0;

	return (
		<View style={styles.row}>
			{visibleImages.map((img, index) => {
				const isLastVisible = index === MAX_VISIBLE - 1 && remaining > 0;

				return (
					<TouchableOpacity
						key={index}
						onPress={() => onPressImage(images, index)}
					>
						<View style={styles.wrapper}>
							<Image source={{ uri: img }} style={styles.thumbnail} />

							{isLastVisible && (
								<View style={styles.overlay}>
									<Text style={styles.overlayText}>+{remaining}</Text>
								</View>
							)}
						</View>
					</TouchableOpacity>
				);
			})}
		</View>
	);
}
